// POST /api/payments/verify  { reference }
// Auth: signed-in order owner (or active admin). Re-verifies with Paystack,
// then settles idempotently. Mirrors `verifyPaystackPayment`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin } = require("../_lib/auth");
const { verifyWithPaystack, settleVerifiedPayment } = require("../_lib/paystack");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const user = await verifyCaller(req, adm);
    const body = parseBody(req);
    const reference = String(body.reference || "").trim();
    if (!/^[A-Za-z0-9._-]{8,100}$/.test(reference)) throw httpError(400, "invalid-argument", "Invalid payment reference.");

    const paymentSnap = await db.doc(`payments/${reference}`).get();
    if (!paymentSnap.exists) throw httpError(404, "not-found", "Payment reference not found.");
    const payment = paymentSnap.data();

    // Ownership: must be the order owner or an active admin.
    const orderSnap = await db.doc(`orders/${payment.orderId}`).get();
    if (!orderSnap.exists) throw httpError(404, "not-found", "The associated order was not found.");
    const order = orderSnap.data();
    if (order.customerUid !== user.uid) {
      await requireAdmin(db, user.uid); // throws 403 unless caller is an active admin
    }
    if (order.customerUid !== payment.customerUid || payment.customerUid !== user.uid) {
      await requireAdmin(db, user.uid); // throws 403 for non-owners
    }

    if (payment.status === "success") return send(res, 200, { status: "success", verified: true, orderId: payment.orderId });

    let transaction;
    try {
      transaction = await verifyWithPaystack(reference);
    } catch (error) {
      console.error("Paystack verify request failed", { reference, error: String(error.message || error) });
      throw httpError(503, "unavailable", "We could not verify this payment right now. Please retry shortly.");
    }
    const outcome = await settleVerifiedPayment(db, FieldValue, reference, transaction);
    return send(res, 200, outcome);
  } catch (err) {
    return errorResponse(res, err);
  }
}
