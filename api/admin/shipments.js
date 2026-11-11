// POST /api/admin/shipments  { action: "create" | "update" | "add-event" | "list", ... }
// Auth: active administrator only. Mirrors createShipment / updateShipment /
// addTrackingEvent / adminListShipments.
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin, cleanString } = require("../_lib/auth");
const { statusAllowed, safeDate } = require("../_lib/shipping");

const ALLOWED_CARRIERS = ["UPS", "DHL", "FedEx", "Aramex", "Other / Manual Carrier"];

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const user = await verifyCaller(req, adm);
    await requireAdmin(db, user.uid);
    const body = parseBody(req);
    const action = String(body.action || "").trim().toLowerCase();

    if (action === "list") {
      const limit = Math.min(300, Math.max(1, Number(body.limit) || 150));
      const snap = await db.collection("shipments").orderBy("createdAt", "desc").limit(limit).get();
      return send(res, 200, { shipments: snap.docs.map(doc => ({ shipmentId: doc.id, ...doc.data() })) });
    }

    if (action === "create") {
      const orderId = cleanString(body.orderId, "orderId", 80);
      const carrier = cleanString(body.carrier, "carrier", 40);
      const trackingNumber = cleanString(body.trackingNumber, "trackingNumber", 80);
      const origin = cleanString(body.origin, "origin", 180);
      const destination = cleanString(body.destination, "destination", 180);
      if (!ALLOWED_CARRIERS.includes(carrier)) throw httpError(400, "invalid-argument", "Unsupported carrier.");
      const orderRef = db.doc(`orders/${orderId}`);
      const orderSnap = await orderRef.get();
      if (!orderSnap.exists) throw httpError(404, "not-found", "Order not found.");
      const shipmentRef = db.collection("shipments").doc();
      const initialStatus = String(body.shipmentStatus || "Shipment Registered");
      if (!statusAllowed(initialStatus)) throw httpError(400, "invalid-argument", "Invalid initial shipment status.");
      const estimatedDelivery = safeDate(body.estimatedDelivery);
      const eventKey = crypto.createHash("sha256").update(`${shipmentRef.id}|${initialStatus}|${trackingNumber}|created`).digest("hex");
      await db.runTransaction(async tx => {
        const freshOrder = await tx.get(orderRef);
        if (!freshOrder.exists) throw httpError(404, "not-found", "Order not found.");
        const latestOrder = freshOrder.data();
        if (latestOrder.status === "Cancelled") throw httpError(409, "failed-precondition", "A cancelled order cannot be shipped.");
        if (latestOrder.paymentOption !== "Cash on delivery" && latestOrder.paymentStatus !== "Paid") {
          throw httpError(409, "failed-precondition", "Prepaid orders must have a verified payment before shipment registration.");
        }
        tx.create(shipmentRef, {
          shipmentId: shipmentRef.id, orderId, customerId: latestOrder.customerUid || null,
          carrier, trackingNumber, origin, destination, shipmentStatus: initialStatus,
          estimatedDelivery, latestUpdate: "Shipment registered", createdBy: user.uid,
          createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        });
        tx.create(db.doc(`trackingEvents/${eventKey}`), {
          eventId: eventKey, shipmentId: shipmentRef.id, orderId, customerId: latestOrder.customerUid || null,
          carrier, status: initialStatus, description: "Shipment registered", location: origin,
          occurredAt: FieldValue.serverTimestamp(), source: "admin", adminUid: user.uid,
          createdAt: FieldValue.serverTimestamp(),
        });
      });
      return send(res, 200, { shipmentId: shipmentRef.id });
    }

    if (action === "update") {
      const shipmentId = cleanString(body.shipmentId, "shipmentId", 100);
      const ref = db.doc(`shipments/${shipmentId}`);
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, "not-found", "Shipment not found.");
      const updates = {};
      for (const key of ["carrier", "trackingNumber", "origin", "destination"]) {
        if (body[key] !== undefined) updates[key] = cleanString(body[key], key, 180);
      }
      if (updates.carrier && !ALLOWED_CARRIERS.includes(updates.carrier)) throw httpError(400, "invalid-argument", "Unsupported carrier.");
      if (body.estimatedDelivery !== undefined) updates.estimatedDelivery = safeDate(body.estimatedDelivery);
      if (body.shipmentStatus !== undefined) {
        updates.shipmentStatus = cleanString(body.shipmentStatus, "shipmentStatus", 60);
        if (!statusAllowed(updates.shipmentStatus)) throw httpError(400, "invalid-argument", "Unsupported shipment status.");
      }
      updates.updatedAt = FieldValue.serverTimestamp();
      const eventRef = db.collection("trackingEvents").doc();
      await db.runTransaction(async tx => {
        const fresh = await tx.get(ref);
        if (!fresh.exists) throw httpError(404, "not-found", "Shipment not found.");
        const current = fresh.data();
        if (updates.shipmentStatus && updates.shipmentStatus !== current.shipmentStatus) {
          tx.create(eventRef, {
            eventId: eventRef.id, shipmentId, orderId: current.orderId, customerId: current.customerId || null,
            carrier: updates.carrier || current.carrier, status: updates.shipmentStatus,
            description: `Shipment status updated to ${updates.shipmentStatus}`,
            location: String(body.location || "").trim().slice(0, 180),
            occurredAt: FieldValue.serverTimestamp(), source: "admin", adminUid: user.uid,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        tx.update(ref, updates);
      });
      return send(res, 200, { ok: true });
    }

    if (action === "add-event") {
      const shipmentId = cleanString(body.shipmentId, "shipmentId", 100);
      const status = cleanString(body.status, "status", 60);
      const description = cleanString(body.description, "description", 300);
      const location = String(body.location || "").trim().slice(0, 180);
      if (!statusAllowed(status)) throw httpError(400, "invalid-argument", "Unsupported shipment status.");
      const occurredAt = safeDate(body.occurredAt) || new Date();
      const ref = db.doc(`shipments/${shipmentId}`);
      const snap = await ref.get();
      if (!snap.exists) throw httpError(404, "not-found", "Shipment not found.");
      const shipment = snap.data();
      const eventKey = crypto.createHash("sha256").update(`${shipmentId}|${status}|${description}|${location}|${occurredAt.toISOString()}`).digest("hex");
      const eventRef = db.doc(`trackingEvents/${eventKey}`);
      let duplicate = false;
      await db.runTransaction(async tx => {
        const [fresh, existing] = await Promise.all([tx.get(ref), tx.get(eventRef)]);
        if (!fresh.exists) throw httpError(404, "not-found", "Shipment not found.");
        if (!existing.exists) tx.create(eventRef, {
          eventId: eventKey, shipmentId, orderId: shipment.orderId, customerId: shipment.customerId || null,
          carrier: shipment.carrier, status, description, location, occurredAt,
          source: "admin", adminUid: user.uid, createdAt: FieldValue.serverTimestamp(),
        });
        else duplicate = true;
        tx.update(ref, { shipmentStatus: status, latestUpdate: description, updatedAt: FieldValue.serverTimestamp() });
      });
      return send(res, 200, { eventId: eventKey, duplicate });
    }

    throw httpError(400, "invalid-argument", "action must be create, update, add-event or list.");
  } catch (err) {
    return errorResponse(res, err);
  }
}
