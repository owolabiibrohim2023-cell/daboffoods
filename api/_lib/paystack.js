// Paystack server logic — mirrors functions/payments.js exactly so behaviour
// is identical on either backend. Amounts are compared in kobo integers.
const crypto = require("node:crypto");
const { httpError } = require("./auth");

const PAYSTACK_API = "https://api.paystack.co";
const CURRENCY = "NGN";

function secretKey() {
  const secret = process.env.PAYSTACK_SECRET_KEY || "";
  if (!secret) throw Object.assign(new Error("PAYSTACK_SECRET_KEY is not configured."), { status: 500, code: "not-configured" });
  return secret;
}

function siteUrl() {
  const clean = v => String(v || "").trim().replace(/\/+$/, "");
  const withScheme = v => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v);
  const configured = clean(process.env.SITE_URL);
  // Ignore the placeholder from .env.example if it was never replaced.
  if (configured && !/your-deployed-domain/i.test(configured)) return withScheme(configured);
  // Vercel provides hosts without "https://", so add it.
  return withScheme(clean(process.env.VERCEL_PROJECT_PRODUCTION_URL) || clean(process.env.VERCEL_URL));
}

async function paystackRequest(path, options = {}) {
  const response = await fetch(`${PAYSTACK_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.status !== true) {
    throw new Error(`Paystack request failed (${response.status}): ${String(result.message || "unknown error").slice(0, 180)}`);
  }
  return result.data;
}

function koboAmount(naira) {
  const amount = Number(naira);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    throw httpError(412, "failed-precondition", "This order does not have a valid confirmed amount due.");
  }
  const kobo = amount * 100;
  if (Math.abs(kobo - Math.round(kobo)) > 1e-7) {
    throw httpError(412, "failed-precondition", "The confirmed order amount must be in increments of one kobo.");
  }
  return Math.round(kobo);
}

async function verifyWithPaystack(reference) {
  if (!/^[A-Za-z0-9._-]{8,100}$/.test(reference)) {
    throw httpError(400, "invalid-argument", "Invalid payment reference.");
  }
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
}

// Idempotent settlement: verify Paystack truth, then update payments/{ref}
// and orders/{orderId} in one transaction. Mirrors settleVerifiedPayment().
async function settleVerifiedPayment(db, FieldValue, reference, transaction) {
  if (!transaction || !/^[A-Za-z0-9._-]{8,100}$/.test(String(transaction.reference || ""))) {
    throw httpError(502, "failed-precondition", "Paystack returned an invalid transaction reference.");
  }
  const permissionDeniedByUs = { status: 409, code: "failed-precondition" };
  let outcome;
  await db.runTransaction(async tx => {
    const paymentRef = db.doc(`payments/${transaction.reference}`);
    const paymentSnap = await tx.get(paymentRef);
    if (!paymentSnap.exists) throw httpError(404, "not-found", "Payment reference not found.");
    const payment = paymentSnap.data();
    const orderRef = db.doc(`orders/${payment.orderId}`);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw httpError(404, "not-found", "The associated order was not found.");
    const order = orderSnap.data();
    if (order.customerUid !== payment.customerUid) throw httpError(409, "failed-precondition", "Payment ownership metadata does not match the order.");

    const paystackAmountNaira = Number(transaction.amount) / 100;
    if (Math.abs(paystackAmountNaira - Number(payment.amountNaira)) > 0.009) throw httpError(409, "failed-precondition", "Paystack amount does not match the amount recorded for this reference.");
    const profileSnap = order.customerUid ? await tx.get(db.doc(`users/${order.customerUid}`)) : null;
    const expectedEmail = profileSnap && profileSnap.exists ? String(profileSnap.data().email || "") : "";
    if (!transaction.customer?.email || transaction.customer.email.toLowerCase() !== expectedEmail.toLowerCase()) throw httpError(409, "failed-precondition", "Paystack customer email does not match the order owner.");
    if (String(transaction.currency || "").toUpperCase() !== String(payment.currency || "NGN").toUpperCase()) throw httpError(409, "failed-precondition", "Paystack currency does not match the amount recorded for this reference.");
    if (String(transaction.metadata?.orderId || "") !== payment.orderId || String(transaction.metadata?.customerUid || "") !== payment.customerUid) throw httpError(409, "failed-precondition", "Paystack ownership metadata does not match this payment record.");

    if (payment.status === "success") { outcome = { status: "success", verified: true, orderId: payment.orderId }; return; }
    if (payment.status === "duplicate_success") throw httpError(409, "failed-precondition", "This payment was already settled. Please contact support for review.");
    if (order.paymentStatus === "Paid") throw httpError(409, "failed-precondition", "This order is already marked as paid. Please contact support for review.");
    if (!["Order Placed", "Confirmed"].includes(order.status) || order.finalPrice == null) throw httpError(409, "failed-precondition", "This payment can no longer be settled because the order is no longer awaiting payment.");
    if (transaction.status !== "success") throw httpError(409, "failed-precondition", "Paystack has not confirmed this transaction as successful.");

    tx.update(paymentRef, {
      status: "success", paidAt: FieldValue.serverTimestamp(),
      verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      paystack: { authorizationCode: transaction.authorization_code || null, container: transaction.channel || null,
        ipAddress: transaction.ip_address || null, device: transaction.device?.phone || null,
        metadata: transaction.metadata || {} },
    });
    tx.update(orderRef, {
      paymentStatus: "Paid", paymentDate: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    outcome = { status: "success", verified: true, orderId: payment.orderId };
  });
  return outcome;
}

module.exports = { PAYSTACK_API, CURRENCY, secretKey, siteUrl, paystackRequest, koboAmount, verifyWithPaystack, settleVerifiedPayment };
