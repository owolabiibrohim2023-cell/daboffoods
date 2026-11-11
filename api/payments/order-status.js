// POST /api/payments/order-status  { orderId, status }
// Auth: active administrator only. Delivery status only — never marks Paid.
// Mirrors `adminUpdateOrderStatus`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin, cleanString } = require("../_lib/auth");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const user = await verifyCaller(req, adm);
    await requireAdmin(db, user.uid);
    const body = parseBody(req);
    const orderId = cleanString(body.orderId, "orderId", 80);
    const nextStatus = cleanString(body.status, "status", 60);
    const allowed = ["Order Placed", "Confirmed", "Picked Up", "In Transit", "Out for Delivery", "Delivered", "Cancelled"];
    if (!allowed.includes(nextStatus)) throw httpError(400, "invalid-argument", "Unsupported order status.");
    const orderRef = db.doc(`orders/${orderId}`);
    const snap = await orderRef.get();
    if (!snap.exists) throw httpError(404, "not-found", "Order not found.");
    const order = snap.data();
    if (order.status === nextStatus) return send(res, 200, { ok: true, changed: false, status: nextStatus });
    const now = FieldValue.serverTimestamp();
    await orderRef.update({
      status: nextStatus,
      statusHistory: FieldValue.arrayUnion({ status: nextStatus, at: now, by: user.uid }),
      updatedAt: now,
    });
    return send(res, 200, { ok: true, changed: true, status: nextStatus });
  } catch (err) {
    return errorResponse(res, err);
  }
}
