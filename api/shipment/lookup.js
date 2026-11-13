
// POST /api/shipment/lookup  { trackingNumber | orderId }
// Public (guest-safe) but IP-rate-limited + sanitized projection only.
// 1) a registered shipment (carrier tracking number or order reference), else
// 2) the order itself (DAB-XXXXX): status history + live rider location.
const { getAdmin } = require("../_lib/admin");
const { parseBody, send, errorResponse, httpError } = require("../_lib/auth");
const { publicShipment, rateLimitLookup, getShipmentEvents } = require("../_lib/shipping");

const iso = value => (value && value.toDate ? value.toDate().toISOString() : value || null);
const liveOf = snap => {
  const data = snap && snap.exists && snap.data().active ? snap.data() : null;
  return data
    ? { lat: Number(data.lat), lng: Number(data.lng), ts: Number(data.ts || 0), riderName: String(data.riderName || "Your rider").slice(0, 80), active: true }
    : null;
};

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    await rateLimitLookup(db, req);
    const body = parseBody(req);
    const lookup = String(body.trackingNumber || body.orderId || "").trim();
    if (!/^[A-Za-z0-9-]{5,80}$/.test(lookup)) throw httpError(400, "invalid-argument", "Enter a valid tracking number or order reference.");

    let shipmentSnap = null;
    const byTracking = await db.collection("shipments").where("trackingNumber", "==", lookup).limit(1).get();
    if (!byTracking.empty) shipmentSnap = byTracking.docs[0];
    else {
      const byOrder = await db.collection("shipments").where("orderId", "==", lookup.toUpperCase()).limit(1).get();
      if (!byOrder.empty) shipmentSnap = byOrder.docs[0];
    }

    if (!shipmentSnap) {
      // No registered shipment: fall back to the order itself (status only, no personal details).
      const orderId = lookup.toUpperCase();
      const orderSnap = await db.doc(`orders/${orderId}`).get();
      if (!orderSnap.exists) throw httpError(404, "not-found", "Shipment not found. Check the tracking number and try again.");
      const order = orderSnap.data();
      const locationSnap = await db.doc(`riderLocations/${orderId}`).get();
      return send(res, 200, {
        shipmentId: null, orderId, carrier: "DABOFFOODS delivery", trackingNumber: orderId,
        origin: "", destination: "", shipmentStatus: order.status || "Order Placed",
        estimatedDelivery: null, createdAt: iso(order.createdAt), updatedAt: iso(order.updatedAt),
        latestUpdate: order.status || "Order Placed",
        events: (order.statusHistory || []).map(event => ({
          status: event.status, description: event.status, location: "", occurredAt: iso(event.at)
        })),
        liveLocation: liveOf(locationSnap)
      });
    }

    const shipment = shipmentSnap.data();
    const events = await getShipmentEvents(db, shipmentSnap.id);
    const result = publicShipment({ shipmentId: shipmentSnap.id, ...shipment }, events);
    const locationSnap = shipment.orderId ? await db.doc(`riderLocations/${shipment.orderId}`).get() : null;
    result.orderId = shipment.orderId || null;
    result.liveLocation = liveOf(locationSnap);
    return send(res, 200, result);
  } catch (err) {
    return errorResponse(res, err);
  }
};