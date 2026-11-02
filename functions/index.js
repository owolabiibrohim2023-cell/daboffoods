/* ============================================================
  DABOFFOODS & LOGISTICS SERVICES — functions/index.js  (Cloud Functions v2)
   Automatic customer + receiver alerts on order events:
     • Order placed          (onDocumentCreated)
     • Confirmed / Picked Up / In Transit / Out for Delivery
     • Delivered / Cancelled (onDocumentUpdated)
     • Payment marked Paid   (onDocumentUpdated)
   Email: Nodemailer + Gmail SMTP (App Password in secrets)
   SMS:   Termii API (API key + Sender ID in secrets)
   Every attempt is logged to Firestore "alerts" for the
   admin Notifications tab. resendAlert powers its Resend button.
============================================================ */
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const nodemailer = require("nodemailer");

/* ============================================================
   ⭐⭐ EDIT HERE — backend business settings ⭐⭐
   SITE_URL must match CONFIG.siteUrl in app.js (no trailing /)
============================================================ */
const SITE_URL = ""; // Set to the deployed site origin before enabling email tracking links.
const BUSINESS_NAME = "DABOFFOODS & LOGISTICS SERVICES";
const BUSINESS_PHONE = "0802 431 1091";
const WHATSAPP_NUMBER = "2348024311091";
const BUSINESS_ADDRESS = "24 Ibadan Road, Behind Tala Book Shop, Ijebu Ode, Ogun State, Nigeria";
/* Master switches — mirror CONFIG.features in app.js */
const EMAIL_ALERTS = true;
const SMS_ALERTS = true;

/* Secrets (set with: firebase functions:secrets:set NAME) */
const GMAIL_USER = defineSecret("GMAIL_USER");
const GMAIL_APP_PASSWORD = defineSecret("GMAIL_APP_PASSWORD");
const TERMII_API_KEY = defineSecret("TERMII_API_KEY");
const TERMII_SENDER_ID = defineSecret("TERMII_SENDER_ID");
const ALL_SECRETS = [GMAIL_USER, GMAIL_APP_PASSWORD, TERMII_API_KEY, TERMII_SENDER_ID];

/*
  Keep the default region us-central1: admin.js calls
  getFunctions() with no region, which targets us-central1.
*/
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

initializeApp();
const db = getFirestore();

/* ---------------- Helpers ---------------- */
const esc = (s = "") => String(s).replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = n => "₦" + Number(n || 0).toLocaleString("en-NG");
const trackingLink = id => `${SITE_URL}/track.html?id=${id}`;
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(e || "").trim());

/* Termii wants international digits WITHOUT +  e.g. 2348137407197 */
function toTermiiNumber(raw = "") {
  let d = String(raw).replace(/\D/g, "");
  if (d.startsWith("0")) d = "234" + d.slice(1);
  else if (/^[789]\d{9}$/.test(d)) d = "234" + d;
  return /^234[789][01]\d{8}$/.test(d) ? d : "";
}
function fill(tpl = "", vars = {}) {
  let out = String(tpl);
  Object.entries(vars).forEach(([k, v]) => { out = out.split(`{${k}}`).join(String(v ?? "")); });
  return out;
}
const DEFAULT_TEMPLATES = {
  emailSubject: "DABOFFOODS shipment update: {orderId} is {status}",
  sms: "DABOFFOODS: Shipment {orderId} is {status}. Track: {trackingLink}",
  whatsapp: "Hello {customerName}, your DABOFFOODS shipment {orderId} is now {status}. Track it here: {trackingLink}"
};
async function getTemplates() {
  try {
    const s = await db.doc("settings/alertTemplates").get();
    return s.exists ? { ...DEFAULT_TEMPLATES, ...s.data() } : DEFAULT_TEMPLATES;
  } catch { return DEFAULT_TEMPLATES; }
}

/* ---------------- Message builders ---------------- */
function buildMessages(order, event, templates) {
  const link = trackingLink(order.orderId);
  const priceText = order.finalPrice != null
    ? `${money(order.finalPrice)} (confirmed)`
    : `${money(order.estimatedPrice)} (estimate — final price confirmed on WhatsApp)`;
  const vars = {
    orderId: order.orderId,
    status: event.displayStatus,
    customerName: order.senderName || "there",
    riderName: order.riderName || "",
    riderPhone: order.riderPhone || "",
    trackingLink: link,
    price: priceText
  };

  const subject = fill(templates.emailSubject, vars);
  let sms = fill(templates.sms, vars);
  /* Out-for-delivery SMS should carry rider contact (your agreed example format) */
  if (event.key === "Out for Delivery" && order.riderName) {
    sms = `DABOFFOODS: Shipment ${order.orderId} is OUT FOR DELIVERY. Rider: ${order.riderName} ${order.riderPhone || ""}. Track: ${link}`.trim();
  }
  if (event.key === "Payment Paid") {
    sms = `DABOFFOODS: Payment received for shipment ${order.orderId}. Thank you! Track: ${link}`;
  }
  if (sms.length > 459) sms = sms.slice(0, 456) + "..."; // hard cap ≈ 3 SMS parts

  const row = (k, v) => v ? `<tr><td style="padding:7px 10px;color:#5b6b85;font-size:13px">${k}</td><td style="padding:7px 10px;font-weight:600;color:#14213d;font-size:14px">${esc(v)}</td></tr>` : "";
  const badgeColor = event.key === "Delivered" ? "#12805c" : event.key === "Cancelled" ? "#c0392b" : "#FF7A00";
  const heading = {
    "Order Placed": "We\u2019ve received your order! 🎉",
    "Confirmed": "Your order is confirmed ✅",
    "Payment Paid": "Payment received — thank you! 💳✅",
    "Picked Up": "Your parcel has been picked up 📦",
    "In Transit": "Your parcel is in transit 🚚",
    "Out for Delivery": "Out for delivery — almost there! 🏍️",
    "Delivered": "Delivered successfully! 🎊",
    "Cancelled": "Order cancelled"
  }[event.key] || `Order update: ${event.displayStatus}`;

  const intro = {
    "Order Placed": "Thanks for your shipment request to DABOFFOODS & LOGISTICS SERVICES. Our team will review your details and contact you about shipping options and a quotation. Keep your reference safe.",
    "Confirmed": `Your delivery is confirmed at <b>${esc(priceText)}</b>. If you haven\u2019t paid yet, please use the payment details confirmed with you on WhatsApp and send your proof of payment there.`,
    "Payment Paid": "We\u2019ve confirmed your payment. No further payment is needed for this order (unless agreed otherwise on WhatsApp).",
    "Picked Up": "Our rider has collected your parcel. You can follow its journey live from the tracking page.",
    "In Transit": "Your parcel is on the move. Watch your rider live on the tracking map.",
    "Out for Delivery": `Your parcel is out for delivery${order.riderName ? ` with <b>${esc(order.riderName)}</b>${order.riderPhone ? ` (${esc(order.riderPhone)})` : ""}` : ""}. Please keep your phone close.`,
    "Delivered": "Your shipment has been marked delivered. Thank you for choosing DABOFFOODS & LOGISTICS SERVICES.",
    "Cancelled": "This order has been cancelled. If you already paid or believe this is a mistake, please contact us immediately on WhatsApp."
  }[event.key] || "";

  const html = `<!doctype html><html><body style="margin:0;background:#f6f9ff;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:22px 12px">
    <div style="background:#0B3D91;border-radius:16px 16px 0 0;padding:24px;text-align:center">
      <div style="color:#fff;font-size:22px;font-weight:800;letter-spacing:.02em">DABOFFOODS &amp; LOGISTICS SERVICES</div>
      <div style="color:#bcd3ff;font-size:13px;margin-top:4px">International logistics · Freight forwarding · Export solutions</div>
    </div>
    <div style="background:#fff;border-radius:0 0 16px 16px;padding:26px 24px;border:1px solid #dbe4f0">
      <h1 style="font-size:21px;color:#072a66;margin:0 0 6px">${heading}</h1>
      <p style="color:#40506a;line-height:1.6;margin:0 0 14px">Hello ${esc(order.senderName || "there")},</p>
      <p style="color:#40506a;line-height:1.6;margin:0 0 16px">${intro}</p>
      <p style="margin:0 0 16px"><span style="display:inline-block;background:${badgeColor};color:#fff;font-weight:700;font-size:13px;padding:7px 14px;border-radius:999px">${esc(event.displayStatus).toUpperCase()}</span>
      &nbsp;<span style="font-weight:800;color:#072a66;font-size:17px">${esc(order.orderId)}</span></p>
      <table style="width:100%;border-collapse:collapse;border:1px solid #dbe4f0;border-radius:10px;margin-bottom:20px">
        ${row("Pickup", order.pickupAddress)}
        ${row("Drop-off", order.dropoffAddress)}
        ${row("Receiver", `${order.receiverName || ""} ${order.receiverPhone ? "· " + order.receiverPhone : ""}`)}
        ${row("Package", `${order.packageType || ""}${order.packageDescription ? " — " + order.packageDescription : ""} (${order.weightKg || 1}kg)`)}
        ${row("Service", order.serviceType)}
        ${row("Price", priceText)}
        ${row("Payment", `${order.paymentStatus || "Pending"}${order.paymentOption ? " · " + order.paymentOption : ""}`)}
        ${order.riderName ? row("Rider", `${order.riderName}${order.riderPhone ? " · " + order.riderPhone : ""}`) : ""}
      </table>
      <p style="text-align:center;margin:0 0 18px">
        <a href="${link}" style="display:inline-block;background:#FF7A00;color:#fff;font-weight:700;text-decoration:none;padding:14px 28px;border-radius:12px">Track My Delivery</a>
      </p>
      <p style="text-align:center;color:#5b6b85;font-size:13px;margin:0 0 6px">or copy this link: <a href="${link}" style="color:#0B3D91">${link}</a></p>
      <hr style="border:none;border-top:1px solid #dbe4f0;margin:18px 0">
      <p style="color:#5b6b85;font-size:13px;line-height:1.6;margin:0">Need help? WhatsApp us: <a href="https://wa.me/${WHATSAPP_NUMBER}" style="color:#0B3D91;font-weight:700">${BUSINESS_PHONE}</a><br>
      ${esc(BUSINESS_NAME)} · ${esc(BUSINESS_ADDRESS)}</p>
    </div>
    <p style="text-align:center;color:#93a5c4;font-size:12px;margin:14px 0">You\u2019re receiving this because a shipment request was booked with this contact.</p>
  </div></body></html>`;

  return { subject, sms, html };
}

/* ---------------- Senders ---------------- */
async function sendEmail(to, subject, html) {
  const user = GMAIL_USER.value(), pass = GMAIL_APP_PASSWORD.value();
  if (!user || !pass) throw new Error("Gmail secrets are not set (GMAIL_USER / GMAIL_APP_PASSWORD).");
  const transporter = nodemailer.createTransport({ service: "gmail", auth: { user, pass } });
  await transporter.sendMail({ from: `"${BUSINESS_NAME}" <${user}>`, to, subject, html });
}
async function sendSms(toRaw, text) {
  const key = TERMII_API_KEY.value(), sender = TERMII_SENDER_ID.value();
  if (!key || !sender) throw new Error("Termii secrets are not set (TERMII_API_KEY / TERMII_SENDER_ID).");
  const to = toTermiiNumber(toRaw);
  if (!to) throw new Error(`Invalid Nigerian phone number for SMS: ${toRaw}`);
  const res = await fetch("https://v3.api.termii.com/api/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: key, to, from: sender, sms: text, type: "plain", channel: "generic" }),
    signal: AbortSignal.timeout(20000)
  });
  let data = {};
  try { data = await res.json(); } catch {}
  const code = String(data.code ?? "").toLowerCase();
  if (!res.ok || (code && !["ok", "200", "success"].includes(code))) {
    throw new Error(`Termii error (${res.status}): ${JSON.stringify(data).slice(0, 280)}`);
  }
}

/* Send one channel + ALWAYS log to the alerts collection */
async function sendAndLog(order, event, channel, to, payload) {
  const base = {
    orderId: order.orderId, event: event.key, channel, to,
    createdAt: FieldValue.serverTimestamp()
  };
  try {
    if (channel === "email") await sendEmail(to, payload.subject, payload.html);
    else if (channel === "sms") await sendSms(to, payload.text);
    else throw new Error("Unknown channel: " + channel);
    const ref = await db.collection("alerts").add({ ...base, status: "sent", error: "", payload });
    return { ok: true, alertId: ref.id };
  } catch (err) {
    logger.error(`Alert failed [${channel} → ${to}] order ${order.orderId}:`, err);
    try {
      const ref = await db.collection("alerts").add({
        ...base, status: "failed", error: String(err.message || err).slice(0, 500), payload
      });
      return { ok: false, alertId: ref.id, error: err.message };
    } catch { return { ok: false, error: err.message }; }
  }
}

/* Build the deduped recipient task list for an event */
async function dispatchAlerts(order, event) {
  if (!order?.orderId) return;
  const templates = await getTemplates();
  const msgs = buildMessages(order, event, templates);
  const prefs = order.notificationPrefs || {};
  const emailOn = EMAIL_ALERTS && prefs.email !== false;
  const smsOn = SMS_ALERTS && prefs.sms !== false;

  /* Receivers get movement alerts only (not price/payment messages) */
  const receiverEvents = ["Order Placed", "Picked Up", "In Transit", "Out for Delivery", "Delivered", "Cancelled"];
  const tasks = [];
  const seen = new Set();
  const add = (channel, to, payload) => {
    const key = channel + "|" + String(to).toLowerCase();
    if (!to || seen.has(key)) return;
    seen.add(key); tasks.push({ channel, to, payload });
  };

  const custEmail = order.customerEmail || order.senderEmail;
  const custPhone = order.customerPhone || order.senderPhone;
  if (emailOn && validEmail(custEmail)) add("email", custEmail, { subject: msgs.subject, html: msgs.html });
  if (smsOn) add("sms", custPhone, { text: msgs.sms });

  if (receiverEvents.includes(event.key)) {
    if (EMAIL_ALERTS && validEmail(order.receiverEmail))
      add("email", order.receiverEmail, { subject: msgs.subject, html: msgs.html });
    if (SMS_ALERTS) {
      add("sms", order.receiverPhoneIntl || order.receiverPhone, { text: msgs.sms });
      (order.stops || []).slice(1).forEach(s => add("sms", s.receiverPhone, { text: msgs.sms }));
    }
  }

  if (!tasks.length) { logger.info(`No alert recipients for order ${order.orderId} (${event.key}).`); return; }
  await Promise.all(tasks.map(t => sendAndLog(order, event, t.channel, t.to, t.payload)));
}

/* ---------------- Firestore triggers ---------------- */
exports.onOrderCreated = onDocumentCreated(
  { document: "orders/{orderId}", secrets: ALL_SECRETS },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const order = { orderId: event.params.orderId, ...snap.data() };
    await dispatchAlerts(order, { key: "Order Placed", displayStatus: order.status || "Order Placed" });
  }
);

exports.onOrderUpdated = onDocumentUpdated(
  { document: "orders/{orderId}", secrets: ALL_SECRETS },
  async (event) => {
    if (!event.data) return;
    const before = event.data.before.data();
    const order = { orderId: event.params.orderId, ...event.data.after.data() };
    const jobs = [];

    /* Auto-clean live location once finished */
    if (before.status !== order.status && ["Delivered", "Cancelled"].includes(order.status)) {
      jobs.push(db.doc(`riderLocations/${order.orderId}`).delete().catch(() => {}));
    }
    /* Status-change alert */
    if (before.status !== order.status && order.status && order.status !== "Order Placed") {
      jobs.push(dispatchAlerts(order, { key: order.status, displayStatus: order.status }));
    }
    /* Payment-marked-Paid alert */
    if (before.paymentStatus !== "Paid" && order.paymentStatus === "Paid") {
      jobs.push(dispatchAlerts(order, { key: "Payment Paid", displayStatus: "Paid" }));
    }
    await Promise.all(jobs);
  }
);

/* ---------------- Admin "Resend alert" callable ---------------- */
exports.resendAlert = onCall({ secrets: ALL_SECRETS }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in as admin.");
  const me = await db.doc(`users/${request.auth.uid}`).get();
  if (!me.exists || me.data().role !== "admin" || me.data().disabled) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  const alertId = String(request.data?.alertId || "");
  if (!alertId) throw new HttpsError("invalid-argument", "alertId is required.");

  const snap = await db.doc(`alerts/${alertId}`).get();
  if (!snap.exists) throw new HttpsError("not-found", "Alert not found.");
  const a = snap.data();
  if (!a.payload || !a.to || !a.channel) {
    throw new HttpsError("failed-precondition",
      "This alert has no stored message payload to resend (it may predate this system). Change the order status instead to trigger a fresh alert.");
  }
  const result = await sendAndLog(
    { orderId: a.orderId },
    { key: a.event || "Resent alert" },
    a.channel, a.to, a.payload
  );
  if (!result.ok) throw new HttpsError("internal", `Resend failed: ${result.error || "unknown error"}. See the new failed entry in the alert log.`);
  return { ok: true, newAlertId: result.alertId };
});