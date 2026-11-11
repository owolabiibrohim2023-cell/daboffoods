
// POST /api/webhooks/paystack — raw Paystack webhook (NO auth header).
// Verifies HMAC-SHA512 signature over the RAW body with a timing-safe
// compare, then independently verifies the transaction with Paystack and
// settles idempotently. Mirrors `paystackWebhook`.
const crypto = require("node:crypto");
const { getAdmin } = require("../_lib/admin");
const { secretKey, verifyWithPaystack, settleVerifiedPayment } = require("../_lib/paystack");

async function getRawBody(req) {
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody;
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === "string") return Buffer.from(req.body);
  // With bodyParser disabled (see config below) the body is still a stream.
  if (req.body === undefined && typeof req.on === "function") {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  // Fallback: runtime already parsed the JSON, so re-serialize it.
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}

async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;
    const signature = String(req.headers["x-paystack-signature"] || "");
    const rawBody = await getRawBody(req);
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

module.exports = handler;
// Ask Vercel not to parse the body so the signature is checked on Paystack's exact bytes.
module.exports.config = { api: { bodyParser: false } };