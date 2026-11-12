// POST /api/shipment/mine  {}  → { shipments: [...] } for the signed-in owner.
// Mirrors `listMyShipments`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, send, errorResponse } = require("../_lib/auth");
const { publicShipment, getShipmentEvents } = require("../_lib/shipping");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const user = await verifyCaller(req, adm);
    const snap = await db.collection("shipments").where("customerId", "==", user.uid).limit(100).get();
    const records = await Promise.all(snap.docs.map(async doc => {
      const data = doc.data();
      return publicShipment({ shipmentId: doc.id, ...data }, await getShipmentEvents(db, doc.id));
    }));
    records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    return send(res, 200, { shipments: records });
  } catch (err) {
    return errorResponse(res, err);
  }
};
