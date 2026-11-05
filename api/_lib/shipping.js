// Shared shipment helpers — mirrors functions/shipping.js.
const crypto = require("node:crypto");
const { httpError } = require("./auth");

function statusAllowed(status) {
  return ["Shipment Registered", "Awaiting Pickup", "Picked Up", "In Transit", "Customs Clearance",
    "Out for Delivery", "Delivered", "Delivery Attempted", "Exception", "On Hold", "Returned"].includes(status);
}

function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw httpError(400, "invalid-argument", "Invalid date value.");
  return date;
}

function publicShipment(shipment, events) {
  return {
    shipmentId: shipment.shipmentId, orderId: shipment.orderId, carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber, origin: shipment.origin || "", destination: shipment.destination || "",
    shipmentStatus: shipment.shipmentStatus, estimatedDelivery: shipment.estimatedDelivery || null,
    latestUpdate: shipment.latestUpdate || "",
    createdAt: shipment.createdAt?.toDate ? shipment.createdAt.toDate().toISOString() : shipment.createdAt || null,
    updatedAt: shipment.updatedAt?.toDate ? shipment.updatedAt.toDate().toISOString() : shipment.updatedAt || null,
    events: events.map(event => ({ status: event.status, description: event.description,
      location: event.location || "", occurredAt: event.occurredAt?.toDate ? event.occurredAt.toDate().toISOString() : event.occurredAt || null })),
  };
}

const LOOKUP_WINDOW_MS = 60 * 1000;
const LOOKUP_LIMIT = 12;

async function rateLimitLookup(db, req) {
  const ip = String(req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
  const key = crypto.createHash("sha256").update(ip).digest("hex");
  const ref = db.doc(`trackingLookupLimits/${key}`);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const record = snap.exists ? snap.data() : {};
    const start = Number(record.windowStart || 0);
    const count = start && start + LOOKUP_WINDOW_MS > now ? Number(record.count || 0) : 0;
    if (count >= LOOKUP_LIMIT) throw httpError(429, "resource-exhausted", "Too many tracking requests. Please wait a minute and try again.");
    tx.set(ref, { windowStart: count ? start : now, count: count + 1, expiresAt: new Date(now + 2 * LOOKUP_WINDOW_MS) });
  });
}

async function getShipmentEvents(db, shipmentId) {
  const snap = await db.collection("trackingEvents").where("shipmentId", "==", shipmentId).limit(100).get();
  return snap.docs.map(doc => doc.data()).sort((a, b) => {
    const time = x => x.occurredAt?.toMillis ? x.occurredAt.toMillis() : new Date(x.occurredAt || 0).getTime();
    return time(b) - time(a);
  });
}

module.exports = { statusAllowed, safeDate, publicShipment, rateLimitLookup, getShipmentEvents };
