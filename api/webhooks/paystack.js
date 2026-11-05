// POST /api/webhooks/paystack — raw Paystack webhook (NO auth header).
// Verifies HMAC-SHA512 signature over the RAW body with a timing-safe
// compare, then independently verifies the transaction with Paystack and
// settles idempotently. Mirrors `paystackWebhook`.
// NOTE: Vercel passes the parsed body when Content-Type is JSON. Paystack
// signs the EXACT bytes, so we re-serialize only if the raw body is absent
// (Vercel Node functions receive req.body parsed; we accept both). If the
// signature check fails we never write state.
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { send, httpError } = require("../_lib/auth");
const { secretKey, verifyWithPaystack, settleVerifiedPayment } = require("../_lib/paystack");

function rawBodyOf(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  // Vercel gives parsed JSON when Content-Type is JSON; re-serializing is
  // byte-identical for Paystack's JSON payloads in practice. We also accept
  // req.rawBody if the runtime provides it.
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const signature = String(req.headers["x-paystack-signature"] || "");
    const rawBody = rawBodyOf(req);
    if (!rawBody.length || !signature) return res.status(400).send("Invalid webhook request");
    const expected = crypto.createHmac("sha512", secretKey()).update(rawBody).digest("hex");
    const suppliedBuffer = Buffer.from(signature, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
      console.warn("Rejected Paystack webhook with invalid signature");
      return res.status(401).send("Invalid signature");
    }
    let parsed;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { return res.status(400).send("Invalid JSON"); }
    const event = parsed?.event;
    const reference = String(parsed?.data?.reference || "");
    if (event !== "charge.success" || !reference) return res.status(200).send("Ignored");

    const eventId = crypto.createHash("sha256").update(`paystack:${event}:${reference}`).digest("hex");
    const eventRef = db.doc(`paymentWebhookEvents/${eventId}`);
    const existing = await eventRef.get();
    if (existing.exists && existing.data().processed === true) return res.status(200).send("Already processed");
    const transaction = await verifyWithPaystack(reference);
    await settleVerifiedPayment(db, FieldValue, reference, transaction);
    await eventRef.set({ event, reference, processed: true, processedAt: FieldValue.serverTimestamp() }, { merge: true });
    return res.status(200).send("OK");
  } catch (error) {
    console.error("Paystack webhook processing failed", { error: String(error.message || error) });
    if (error && error.status && [404, 409].includes(error.status)) return res.status(200).send("Payment not applied");
    return res.status(500).send("Retry later");
  }
}
