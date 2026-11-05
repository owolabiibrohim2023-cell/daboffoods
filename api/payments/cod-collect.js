// POST /api/payments/cod-collect  { orderId, collectionReference? }
// Auth: active administrator only. Mirrors `recordCodCollection`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin } = require("../_lib/auth");
const { CURRENCY } = require("../_lib/paystack");

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
    const orderId = String(body.orderId || "").trim();
    const collectionReference = String(body.collectionReference || "").trim().slice(0, 100);
    if (!/^[A-Za-z0-9-]{4,80}$/.test(orderId)) throw httpError(400, "invalid-argument", "A valid order ID is required.");

    const orderRef = db.doc(`orders/${orderId}`);
    const paymentRef = db.doc(`payments/COD-${orderId}`);
    await db.runTransaction(async tx => {
      const orderSnap = await tx.get(orderRef);
      const paymentSnap = await tx.get(paymentRef);
      if (!orderSnap.exists) throw httpError(404, "not-found", "Order not found.");
      const order = orderSnap.data();
      if (order.paymentOption !== "Cash on delivery" && order.paymentStatus !== "COD") {
        throw httpError(409, "failed-precondition", "This is not a cash-on-delivery order.");
      }
      if (order.paymentStatus === "Paid") return;
      const amountNaira = Number(order.finalPrice);
      if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
        throw httpError(409, "failed-precondition", "Set the confirmed order amount before recording COD collection.");
      }
      tx.set(paymentRef, {
        reference: `COD-${orderId}`, orderId, customerUid: order.customerUid || null,
        amountNaira, currency: CURRENCY, method: "cash-on-delivery", status: "success",
        collectionReference: collectionReference || null, collectedBy: user.uid,
        createdAt: paymentSnap.exists ? paymentSnap.data().createdAt : FieldValue.serverTimestamp(),
        paidAt: FieldValue.serverTimestamp(), verifiedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      tx.update(orderRef, {
        paymentStatus: "Paid", paymentDate: FieldValue.serverTimestamp(),
        codCollectedBy: user.uid, codCollectionReference: collectionReference || null,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });
    return send(res, 200, { status: "success", orderId });
  } catch (err) {
    return errorResponse(res, err);
  }
}
