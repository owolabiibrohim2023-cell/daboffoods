// UPS OAuth + tracking — mirrors functions/shipping.js. Tokens are cached
// in memory only and never sent to the browser.
const crypto = require("node:crypto");
const { httpError } = require("./auth");

let tokenCache = { value: "", expiresAt: 0 };

function upsCredentials() {
  const clientId = process.env.UPS_CLIENT_ID || "";
  const clientSecret = process.env.UPS_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) {
    throw Object.assign(new Error("UPS credentials are not configured."), { status: 500, code: "not-configured" });
  }
  return { clientId, clientSecret };
}

function baseUrl() {
  return String(process.env.UPS_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "https://onlinetools.ups.com"
    : "https://wwwcie.ups.com";
}

async function getUpsAccessToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 60_000) return tokenCache.value;
  const { clientId, clientSecret } = upsCredentials();
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${baseUrl()}/security/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(`UPS OAuth failed (${response.status}): ${String(data.error_description || data.error || "authentication failed").slice(0, 160)}`);
  }
  tokenCache = { value: data.access_token, expiresAt: now + Math.max(60, Number(data.expires_in) || 3600) * 1000 };
  return tokenCache.value;
}

function mapUpsStatus(code, description) {
  const normalized = String(code || "").toUpperCase();
  const text = String(description || "").toLowerCase();
  if (normalized === "D" || text.includes("delivered")) return "Delivered";
  if (normalized === "X" || text.includes("exception")) return "Exception";
  if (normalized === "I" || text.includes("in transit")) return "In Transit";
  if (normalized === "O" || text.includes("out for delivery")) return "Out for Delivery";
  if (normalized === "P" || text.includes("pickup")) return "Picked Up";
  return "Shipment Registered";
}

function extractUpsTracking(data) {
  const shipment = data?.trackResponse?.shipment?.[0];
  const track = shipment?.package?.[0];
  if (!shipment || !track) throw httpError(404, "not-found", "UPS returned no tracking details for this number.");
  const activity = Array.isArray(track.activity) ? track.activity : [];
  const localUpsDateTime = (date, time) => {
    if (!/^\d{8}$/.test(String(date || "")) || !/^\d{6}$/.test(String(time || ""))) return null;
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
  };
  const events = activity.map(item => {
    const location = item.location?.address || {};
    return {
      status: mapUpsStatus(item.status?.type, item.status?.description),
      description: String(item.status?.description || "UPS tracking update").slice(0, 250),
      location: [location.city, location.stateProvince, location.country].filter(Boolean).join(", ").slice(0, 160),
      occurredAt: localUpsDateTime(item.date, item.time),
      carrierStatusCode: String(item.status?.code || "").slice(0, 24),
    };
  }).filter(event => event.occurredAt);
  const current = track.currentStatus || {};
  const deliveryDate = shipment.deliveryDate?.[0]?.date;
  const estimatedDelivery = deliveryDate && /^\d{8}$/.test(deliveryDate)
    ? `${deliveryDate.slice(0, 4)}-${deliveryDate.slice(4, 6)}-${deliveryDate.slice(6, 8)}` : null;
  const address = value => [value?.city, value?.stateProvince, value?.country].filter(Boolean).join(", ").slice(0, 160);
  return {
    carrier: "UPS",
    trackingNumber: String(track.trackingNumber || "").slice(0, 60),
    shipmentStatus: mapUpsStatus(current.type, current.description),
    latestUpdate: String(current.description || events[0]?.description || "UPS tracking update").slice(0, 250),
    origin: address(shipment.shipper?.address),
    destination: address(shipment.shipTo?.address),
    estimatedDelivery,
    events: events.slice(0, 50),
  };
}

async function callUpsTracking(trackingNumber, retryAfterUnauthorized = true) {
  const token = await getUpsAccessToken();
  const response = await fetch(`${baseUrl()}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US&returnSignature=false`, {
    headers: { Authorization: `Bearer ${token}`, transId: crypto.randomUUID(), transactionSrc: "daboffoods-website" },
    signal: AbortSignal.timeout(25000),
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    tokenCache = { value: "", expiresAt: 0 };
    if (retryAfterUnauthorized) return callUpsTracking(trackingNumber, false);
    throw httpError(503, "unavailable", "UPS authorization expired. Please retry the tracking request.");
  }
  if (response.status === 404 || response.status === 400) throw httpError(404, "not-found", "UPS could not find a shipment with that tracking number.");
  if (!response.ok) throw httpError(503, "unavailable", "UPS tracking is temporarily unavailable.");
  return extractUpsTracking(data);
}

module.exports = { getUpsAccessToken, callUpsTracking, mapUpsStatus, extractUpsTracking };
