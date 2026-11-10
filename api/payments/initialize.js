
// POST /api/payments/initialize  { orderId }  → { authorizationUrl, reference }
// Auth: signed-in customer who owns the order + confirmed finalPrice.
// Mirrors Cloud Functions `initializePaystackPayment` (functions/payments.js).
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError } = require("../_lib/auth");
const { paystackRequest, koboAmount, siteUrl, CURRENCY } = require("../_lib/paystack");

module.exports = async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const user = await verifyCaller(req, adm);
    const body = parseBody(req);
    const orderId = String(body.orderId || "").trim();
    if (!/^[A-Za-z0-9-]{4,80}$/.test(orderId)) throw httpError(400, "invalid-argument", "A valid order ID is required.");

    const orderRef = db.doc(`orders/${orderId}`);
    const orderSnap = await orderRef.get();
    if (!orderSnap.exists) throw httpError(404, "not-found", "Order not found.");
    const order = orderSnap.data();
    if (order.customerUid !== user.uid) throw httpError(403, "permission-denied", "You can only pay for your own orders.");
    if (order.paymentStatus === "Paid") throw httpError(409, "failed-precondition", "This order is already paid.");
    // Legacy guard only: Cash on Delivery is no longer offered, but old COD
    // records are preserved and must not be paid online by mistake.
    if (order.paymentStatus === "COD" || order.paymentOption === "Cash on delivery") throw httpError(409, "failed-precondition", "This order was booked before cash on delivery was discontinued. Please contact support to settle it.");
    if (!["Order Placed", "Confirmed"].includes(order.status)) throw httpError(409, "failed-precondition", "This order is no longer awaiting payment.");
    if (order.finalPrice == null) throw httpError(409, "failed-precondition", "Our team has not confirmed a final amount for this order yet.");

    const amount = koboAmount(order.finalPrice);
    const customerSnap = await db.doc(`users/${user.uid}`).get();
    if (!customerSnap.exists) throw httpError(404, "not-found", "Your customer profile was not found.");
    const customerProfile = customerSnap.data();
    if (customerProfile.disabled === true) throw httpError(403, "permission-denied", "This account is disabled. Please contact support.");
    const customerRecord = await adm.auth().getUser(user.uid).catch(() => null);
    const email = customerProfile.email || (customerRecord && customerRecord.email);
    if (!email) throw httpError(409, "failed-precondition", "Your account is missing an email address. Please contact support.");

    const reference = `DAB-${crypto.randomBytes(18).toString("hex")}`;
    const paymentRef = db.doc(`payments/${reference}`);
    await paymentRef.create({
      reference, orderId, customerUid: user.uid,
      customerEmail: email, amountNaira: order.finalPrice, amountKobo: amount,
      currency: CURRENCY, method: "paystack", status: "pending",
      createdAt: FieldValue.serverTimestamp(),
    });

    // Callback only works with a full https:// site URL (see siteUrl()).
    const baseSite = siteUrl();
    const callbackUrl = /^https:\/\//i.test(baseSite)
      ? `${baseSite}/account.html?payment_reference=${encodeURIComponent(reference)}`
      : undefined;
    if (!callbackUrl) {
      console.warn("SITE_URL is not an https URL; Paystack will use the callback set in the Paystack dashboard.");
    }

    let data;
    try {
      data = await paystackRequest("/transaction/initialize", {
        method: "POST",
        body: JSON.stringify({
          email, amount, currency: CURRENCY, reference,
          metadata: { orderId, customerUid: user.uid },
          ...(callbackUrl ? { callback_url: callbackUrl } : {}),
        }),
      });
    } catch (error) {
      console.error("Paystack initialize failed", { orderId, error: String(error.message || error) });
      try { await paymentRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() }); } catch {}
      throw httpError(502, "unavailable", "We could not start your payment right now. Please try again shortly.");
    }

    if (!data.authorization_url || !String(data.authorization_url).startsWith("https://checkout.paystack.com/")) {
      try { await paymentRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() }); } catch {}
      throw httpError(502, "unavailable", "Paystack did not return a valid checkout URL.");
    }
    await paymentRef.update({ updatedAt: FieldValue.serverTimestamp() });
    return send(res, 200, { authorizationUrl: data.authorization_url, reference });
  } catch (err) {
    return errorResponse(res, err);
  }
};