// POST /api/shipment/ups-refresh  { shipmentId }
// Auth: signed-in shipment owner or active admin. Fetches official UPS data
// server-side, stores deduplicated events. Mirrors `trackUpsShipment`.
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin } = require("../_lib/auth");
const { callUpsTracking } = require("../_lib/ups");

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const user = await verifyCaller(req, adm);
    const body = parseBody(req);
    const shipmentId = String(body.shipmentId || "").trim();
    if (!shipmentId) throw httpError(400, "invalid-argument", "shipmentId is required.");
    const ref = db.doc(`shipments/${shipmentId}`);
    const snap = await ref.get();
    if (!snap.exists) throw httpError(404, "not-found", "Shipment not found.");
    const shipment = snap.data();
    if (shipment.customerId !== user.uid) await requireAdmin(db, user.uid);
    if (String(shipment.carrier).toUpperCase() !== "UPS") throw httpError(409, "failed-precondition", "Live tracking is currently available only for UPS shipments.");
    if (!shipment.trackingNumber) throw httpError(409, "failed-precondition", "This shipment does not have a tracking number yet.");

    let ups;
    try {
      ups = await callUpsTracking(shipment.trackingNumber);
    } catch (error) {
      if (error && error.status === 404) throw error;
      console.error("UPS lookup failed", { shipmentId, error: String(error.message || error) });
      throw httpError(503, "unavailable", "UPS tracking is temporarily unavailable. Your existing tracking information is unchanged.");
    }

    const events = ups.events.map(event => {
      const eventKey = crypto.createHash("sha256").update(`${shipmentId}|${event.carrierStatusCode || ""}|${event.description}|${event.occurredAt}`).digest("hex");
      return {
        eventId: eventKey, shipmentId, orderId: shipment.orderId, customerId: shipment.customerId || null,
        carrier: "UPS", status: event.status, description: event.description,
        location: event.location, occurredAt: new Date(event.occurredAt),
        source: "ups", createdAt: FieldValue.serverTimestamp(),
      };
    });
    await db.runTransaction(async tx => {
      const fresh = await tx.get(ref);
      if (!fresh.exists) throw httpError(404, "not-found", "Shipment not found.");
      const current = fresh.data();
      tx.update(ref, {
        shipmentStatus: ups.shipmentStatus,
        latestUpdate: ups.latestUpdate,
        origin: current.origin || ups.origin,
        destination: current.destination || ups.destination,
        estimatedDelivery: ups.estimatedDelivery || current.estimatedDelivery || null,
        lastUpsRefreshAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      events.forEach(event => {
        const eventRef = db.doc(`trackingEvents/${event.eventId}`);
        tx.set(eventRef, event, { merge: true });
      });
    });
    return send(res, 200, { ok: true, status: ups.shipmentStatus, events: events.length });
  } catch (err) {
    return errorResponse(res, err);
  }
}
