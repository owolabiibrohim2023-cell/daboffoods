// POST /api/admin/payments
//   { action: "list" }                         → { payments: [...] }   (adminListPayments)
//   { action: "link-order", orderId, customerId } → link (linkOrderToCustomer)
// Auth: active administrator only. Merged into ONE function to stay within
// Vercel Hobby's 12-function limit (this file replaced link-order.js).
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
    const action = String(body.action || "list").trim().toLowerCase();

    if (action === "list") {
      const limit = Math.min(250, Math.max(1, Number(body.limit) || 100));
      const snap = await db.collection("payments").orderBy("createdAt", "desc").limit(limit).get();
      return send(res, 200, { payments: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
    }

    if (action === "link-order") {
      const orderId = cleanString(body.orderId, "orderId", 80);
      const customerId = cleanString(body.customerId, "customerId", 128);
      const userRecord = await adm.auth().getUser(customerId).catch(() => null);
      if (!userRecord) throw httpError(404, "not-found", "Firebase Authentication user not found.");
      const profileSnap = await db.doc(`users/${customerId}`).get();
      if (!profileSnap.exists || profileSnap.data().role !== "customer" || profileSnap.data().disabled) {
        throw httpError(409, "failed-precondition", "Select an active customer profile.");
      }
      const ref = db.doc(`orders/${orderId}`);
      await db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) throw httpError(404, "not-found", "Order not found.");
        if (snap.data().customerUid && snap.data().customerUid !== customerId) {
          throw httpError(409, "failed-precondition", "This order is already linked to another customer.");
        }
        tx.update(ref, { customerUid: customerId, customerEmail: userRecord.email || snap.data().customerEmail || "", updatedAt: FieldValue.serverTimestamp() });
      });
      return send(res, 200, { ok: true });
    }

    throw httpError(400, "invalid-argument", "action must be list or link-order.");
  } catch (err) {
    return errorResponse(res, err);
  }
}
