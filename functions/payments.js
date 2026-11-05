const crypto = require("node:crypto");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { defineSecret } = require("firebase-functions/params");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

const db = getFirestore();
const PAYSTACK_SECRET_KEY = defineSecret("PAYSTACK_SECRET_KEY");
const PAYSTACK_API = "https://api.paystack.co";
const CURRENCY = "NGN";
const SITE_URL = String(process.env.SITE_URL || "").replace(/\/$/, "");

async function getProfile(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function requireAdmin(uid) {
  const profile = await getProfile(uid);
  if (!profile || profile.role !== "admin" || profile.disabled) {
    throw new HttpsError("permission-denied", "Administrator access is required.");
  }
  return profile;
}

function requireUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  return request.auth;
}

async function paystackRequest(path, options = {}) {
  const secret = PAYSTACK_SECRET_KEY.value();
  if (!secret) throw new Error("Paystack secret is not configured.");
  const response = await fetch(`${PAYSTACK_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
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
    throw new HttpsError("failed-precondition", "This order does not have a valid confirmed amount due.");
  }
  const kobo = amount * 100;
  if (Math.abs(kobo - Math.round(kobo)) > 1e-7) {
    throw new HttpsError("failed-precondition", "The confirmed order amount must be in increments of one kobo.");
  }
  return Math.round(kobo);
}

async function assertCanAccessPayment(uid, payment) {
  const orderSnap = await db.doc(`orders/${payment.orderId}`).get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "The associated order was not found.");
  const order = orderSnap.data();
  if (order.customerUid !== uid) await requireAdmin(uid);
  if (order.customerUid !== payment.customerUid || payment.customerUid !== uid) {
    const profile = await getProfile(uid);
    if (!profile || profile.role !== "admin" || profile.disabled) {
      throw new HttpsError("permission-denied", "You cannot access this payment.");
    }
  }
  return order;
}

async function verifyWithPaystack(reference) {
  if (!/^[A-Za-z0-9._-]{8,100}$/.test(reference)) {
    throw new HttpsError("invalid-argument", "Invalid payment reference.");
  }
  return paystackRequest(`/transaction/verify/${encodeURIComponent(reference)}`);
}

async function settleVerifiedPayment(reference, transaction) {
  const paymentRef = db.doc(`payments/${reference}`);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw new HttpsError("not-found", "Payment reference not found.");
  const payment = paymentSnap.data();
  const orderRef = db.doc(`orders/${payment.orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Associated order not found.");
  const order = orderSnap.data();

  const verified = transaction.status === "success"
    && transaction.reference === reference
    && Number(transaction.amount) === Number(payment.amountKobo)
    && transaction.currency === payment.currency
    && transaction.currency === CURRENCY
    && String(transaction.customer?.email || "").toLowerCase() === String(payment.email || "").toLowerCase()
    && String(transaction.metadata?.orderId || "") === payment.orderId
    && String(transaction.metadata?.customerUid || "") === payment.customerUid
    && order.customerUid === payment.customerUid
    && koboAmount(order.finalPrice) === Number(payment.amountKobo);

  if (!verified) {
    if (transaction.status !== "success") {
      const gatewayStatus = String(transaction.status || "unknown").toLowerCase();
      const terminalFailure = ["failed", "abandoned", "reversed"].includes(gatewayStatus);
      if (terminalFailure) {
        await db.runTransaction(async tx => {
          const [fresh, freshOrder] = await Promise.all([tx.get(paymentRef), tx.get(orderRef)]);
          if (fresh.exists && fresh.data().status !== "success") {
            tx.update(paymentRef, { status: "failed", gatewayStatus, updatedAt: FieldValue.serverTimestamp() });
            if (freshOrder.exists && freshOrder.data().activePaymentReference === reference) {
              tx.update(orderRef, { activePaymentReference: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });
            }
          }
        });
      } else {
        await paymentRef.update({ status: "pending", gatewayStatus, updatedAt: FieldValue.serverTimestamp() });
      }
      return { status: gatewayStatus, verified: false };
    }
    logger.error("Paystack verification mismatch", { reference, orderId: payment.orderId });
    throw new HttpsError("failed-precondition", "Payment verification details did not match the order.");
  }

  let duplicateSuccess = false;
  await db.runTransaction(async tx => {
    const freshPayment = await tx.get(paymentRef);
    const freshOrder = await tx.get(orderRef);
    if (!freshPayment.exists || !freshOrder.exists) throw new HttpsError("not-found", "Payment or order was removed.");
    const currentPayment = freshPayment.data();
    const currentOrder = freshOrder.data();
    if (currentPayment.status === "success") return;
    if (currentOrder.paymentStatus === "Paid" && currentOrder.paymentReference !== reference) {
      duplicateSuccess = true;
      tx.update(paymentRef, {
        status: "duplicate_success", gatewayStatus: "success", gatewayTransactionId: String(transaction.id || ""),
        refundReviewRequired: true, verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
      });
      return;
    }
    if (currentOrder.customerUid !== currentPayment.customerUid
      || koboAmount(currentOrder.finalPrice) !== Number(currentPayment.amountKobo)
      || currentOrder.status === "Cancelled"
      || currentOrder.paymentOption === "Cash on delivery") {
      throw new HttpsError("failed-precondition", "The order changed or is not eligible for online payment.");
    }
    tx.update(paymentRef, {
      status: "success", gatewayStatus: "success", paidAt: Timestamp.fromMillis(Number(transaction.paid_at ? Date.parse(transaction.paid_at) : Date.now())),
      gatewayTransactionId: String(transaction.id || ""), channel: String(transaction.channel || ""),
      verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.update(orderRef, {
      paymentStatus: "Paid", paymentOption: "Paystack", paymentReference: reference,
      paymentDate: FieldValue.serverTimestamp(), activePaymentReference: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  return duplicateSuccess
    ? { status: "duplicate_success", verified: false, orderId: payment.orderId, reviewRequired: true }
    : { status: "success", verified: true, orderId: payment.orderId };
}

exports.initializePaystackPayment = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async request => {
  const user = requireUser(request);
  const orderId = String(request.data?.orderId || "").trim();
  if (!/^[A-Za-z0-9-]{4,80}$/.test(orderId)) throw new HttpsError("invalid-argument", "A valid order ID is required.");
  const orderRef = db.doc(`orders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
  const order = orderSnap.data();
  if (order.customerUid !== user.uid) throw new HttpsError("permission-denied", "You can only pay for your own orders.");
  if (order.status === "Cancelled" || order.paymentOption === "Cash on delivery" || order.paymentStatus === "Paid") {
    throw new HttpsError("failed-precondition", "This order is not eligible for online payment.");
  }
  const amount = koboAmount(order.finalPrice);
  const email = String(user.token.email || order.customerEmail || order.senderEmail || "").trim().toLowerCase();
  if (!email || !email.includes("@")) throw new HttpsError("failed-precondition", "A valid email is required for Paystack.");
  if (order.activePaymentReference) {
    const activePayment = await db.doc(`payments/${order.activePaymentReference}`).get();
    if (activePayment.exists && activePayment.data().customerUid === user.uid
      && activePayment.data().status === "pending" && activePayment.data().authorizationUrl) {
      return { authorizationUrl: activePayment.data().authorizationUrl, reference: activePayment.id, reused: true };
    }
  }
  const reference = `DAB-${crypto.randomBytes(18).toString("hex")}`;
  const paymentRef = db.doc(`payments/${reference}`);
  const callbackUrl = /^https:\/\//i.test(SITE_URL)
    ? `${SITE_URL}/account.html?payment_reference=${encodeURIComponent(reference)}`
    : undefined;
  const now = FieldValue.serverTimestamp();

  await db.runTransaction(async tx => {
    const fresh = await tx.get(orderRef);
    if (!fresh.exists) throw new HttpsError("not-found", "Order not found.");
    const latest = fresh.data();
    if (latest.customerUid !== user.uid || latest.paymentStatus === "Paid" || latest.status === "Cancelled"
      || latest.paymentOption === "Cash on delivery" || koboAmount(latest.finalPrice) !== amount) {
      throw new HttpsError("failed-precondition", "The order changed and cannot be paid with this request.");
    }
    const active = latest.activePaymentReference;
    if (active) {
      const activeSnap = await tx.get(db.doc(`payments/${active}`));
      if (activeSnap.exists && ["initializing", "pending"].includes(activeSnap.data().status)) {
        throw new HttpsError("already-exists", "A payment is already in progress for this order.");
      }
    }
    tx.create(paymentRef, {
      reference, orderId, customerUid: user.uid, email, amountKobo: amount, amountNaira: amount / 100,
      currency: CURRENCY, status: "initializing", method: "paystack", createdAt: now, updatedAt: now
    });
    tx.update(orderRef, { paymentOption: "Paystack", activePaymentReference: reference, updatedAt: now });
  });

  try {
    const initialized = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email, amount, currency: CURRENCY, reference,
        metadata: { orderId, customerUid: user.uid }, ...(callbackUrl ? { callback_url: callbackUrl } : {})
      })
    });
    await paymentRef.update({ status: "pending", authorizationUrl: initialized.authorization_url, accessCode: initialized.access_code, updatedAt: FieldValue.serverTimestamp() });
    return { authorizationUrl: initialized.authorization_url, reference };
  } catch (error) {
    await paymentRef.update({ status: "failed", errorCode: "initialization_failed", updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    await orderRef.update({ activePaymentReference: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    logger.error("Paystack initialization failed", { orderId, error: String(error.message || error) });
    throw new HttpsError("unavailable", "Could not start payment. Please try again later.");
  }
});

exports.verifyPaystackPayment = onCall({ secrets: [PAYSTACK_SECRET_KEY] }, async request => {
  const user = requireUser(request);
  const reference = String(request.data?.reference || "").trim();
  const paymentSnap = await db.doc(`payments/${reference}`).get();
  if (!paymentSnap.exists) throw new HttpsError("not-found", "Payment reference not found.");
  const payment = paymentSnap.data();
  await assertCanAccessPayment(user.uid, payment);
  if (payment.status === "success") return { status: "success", verified: true, orderId: payment.orderId };
  let transaction;
  try { transaction = await verifyWithPaystack(reference); }
  catch (error) {
    logger.error("Paystack verify request failed", { reference, error: String(error.message || error) });
    throw new HttpsError("unavailable", "We could not verify this payment right now. Please retry shortly.");
  }
  return settleVerifiedPayment(reference, transaction);
});

exports.recordCodCollection = onCall(async request => {
  const user = requireUser(request);
  await requireAdmin(user.uid);
  const orderId = String(request.data?.orderId || "").trim();
  const collectionReference = String(request.data?.collectionReference || "").trim().slice(0, 100);
  if (!/^[A-Za-z0-9-]{4,80}$/.test(orderId)) throw new HttpsError("invalid-argument", "A valid order ID is required.");
  const orderRef = db.doc(`orders/${orderId}`);
  const paymentRef = db.doc(`payments/COD-${orderId}`);
  await db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    const paymentSnap = await tx.get(paymentRef);
    if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const order = orderSnap.data();
    if (order.paymentOption !== "Cash on delivery" && order.paymentStatus !== "COD") {
      throw new HttpsError("failed-precondition", "This is not a cash-on-delivery order.");
    }
    if (order.paymentStatus === "Paid") return;
    const amountNaira = Number(order.finalPrice);
    if (!Number.isFinite(amountNaira) || amountNaira <= 0) {
      throw new HttpsError("failed-precondition", "Set the confirmed order amount before recording COD collection.");
    }
    tx.set(paymentRef, {
      reference: `COD-${orderId}`, orderId, customerUid: order.customerUid || null,
      amountNaira,
      currency: CURRENCY, method: "cash-on-delivery", status: "success",
      collectionReference: collectionReference || null, collectedBy: user.uid,
      createdAt: paymentSnap.exists ? paymentSnap.data().createdAt : FieldValue.serverTimestamp(),
      paidAt: FieldValue.serverTimestamp(), verifiedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    tx.update(orderRef, {
      paymentStatus: "Paid", paymentDate: FieldValue.serverTimestamp(),
      codCollectedBy: user.uid, codCollectionReference: collectionReference || null,
      updatedAt: FieldValue.serverTimestamp()
    });
  });
  return { status: "success", orderId };
});

exports.paystackWebhook = onRequest({ secrets: [PAYSTACK_SECRET_KEY], timeoutSeconds: 60 }, async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  const signature = String(req.get("x-paystack-signature") || "");
  const rawBody = req.rawBody;
  if (!Buffer.isBuffer(rawBody) || !signature) return res.status(400).send("Invalid webhook request");
  const expected = crypto.createHmac("sha512", PAYSTACK_SECRET_KEY.value()).update(rawBody).digest("hex");
  const suppliedBuffer = Buffer.from(signature, "hex"), expectedBuffer = Buffer.from(expected, "hex");
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    logger.warn("Rejected Paystack webhook with invalid signature");
    return res.status(401).send("Invalid signature");
  }
  const event = req.body?.event;
  const reference = String(req.body?.data?.reference || "");
  if (event !== "charge.success" || !reference) return res.status(200).send("Ignored");
  const eventId = crypto.createHash("sha256").update(`paystack:${event}:${reference}`).digest("hex");
  const eventRef = db.doc(`paymentWebhookEvents/${eventId}`);
  try {
    const existing = await eventRef.get();
    if (existing.exists && existing.data().processed === true) return res.status(200).send("Already processed");
    const transaction = await verifyWithPaystack(reference);
    await settleVerifiedPayment(reference, transaction);
    await eventRef.set({ event, reference, processed: true, processedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).send("OK");
  } catch (error) {
    if (error instanceof HttpsError && ["not-found", "failed-precondition"].includes(error.code)) {
      logger.error("Paystack webhook verification rejected", { reference, code: error.code });
      return res.status(200).send("Payment not applied");
    }
    logger.error("Paystack webhook processing failed", { reference, error: String(error.message || error) });
    return res.status(500).send("Retry later");
  }
});
