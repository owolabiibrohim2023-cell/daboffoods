// POST /api/shipment/lookup  { trackingNumber | orderId }
// Public (guest-safe) but IP-rate-limited + sanitized projection only.
// Mirrors `lookupShipment`.
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { parseBody, send, errorResponse, httpError } = require("../_lib/auth");
const { statusAllowed, safeDate, publicShipment, rateLimitLookup, getShipmentEvents } = require("../_lib/shipping");

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
    if (!shipmentSnap) throw httpError(404, "not-found", "Shipment not found. Check the tracking number and try again.");
    const shipment = shipmentSnap.data();
    const events = await getShipmentEvents(db, shipmentSnap.id);
    const result = publicShipment({ shipmentId: shipmentSnap.id, ...shipment }, events);
    const locationSnap = shipment.orderId ? await db.doc(`riderLocations/${shipment.orderId}`).get() : null;
    const location = locationSnap?.exists && locationSnap.data().active ? locationSnap.data() : null;
    result.orderId = shipment.orderId || null;
    result.liveLocation = location
      ? { lat: Number(location.lat), lng: Number(location.lng), ts: Number(location.ts || 0), riderName: String(location.riderName || "Your rider").slice(0, 80), active: true }
      : null;
    return send(res, 200, result);
  } catch (err) {
    return errorResponse(res, err);
  }
};
