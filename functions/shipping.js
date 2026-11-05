const crypto = require("node:crypto");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getAuth } = require("firebase-admin/auth");
const { defineSecret } = require("firebase-functions/params");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");

const db = getFirestore();
const UPS_CLIENT_ID = defineSecret("UPS_CLIENT_ID");
const UPS_CLIENT_SECRET = defineSecret("UPS_CLIENT_SECRET");
const LOOKUP_WINDOW_MS = 60 * 1000;
const LOOKUP_LIMIT = 12;
let tokenCache = { value: "", expiresAt: 0 };

async function getProfile(uid) {
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}
async function requireAdmin(uid) {
  const profile = await getProfile(uid);
  if (!profile || profile.role !== "admin" || profile.disabled) throw new HttpsError("permission-denied", "Administrator access is required.");
  return profile;
}
function requireUser(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Please sign in first.");
  return request.auth;
}
function cleanString(value, name, maxLength = 180) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) throw new HttpsError("invalid-argument", `${name} is required and must be ${maxLength} characters or fewer.`);
  return text;
}
function safeDate(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new HttpsError("invalid-argument", "Invalid date value.");
  return date;
}
function statusAllowed(status) {
  return ["Shipment Registered", "Awaiting Pickup", "Picked Up", "In Transit", "Customs Clearance", "Out for Delivery", "Delivered", "Delivery Attempted", "Exception", "On Hold", "Returned"].includes(status);
}

// UPS OAuth tokens stay in process memory and are never returned from a callable.
async function getUpsAccessToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 60_000) return tokenCache.value;
  const clientId = UPS_CLIENT_ID.value(), clientSecret = UPS_CLIENT_SECRET.value();
  if (!clientId || !clientSecret) throw new Error("UPS credentials are not configured.");
  const production = String(process.env.UPS_ENVIRONMENT || "sandbox").toLowerCase() === "production";
  const baseUrl = production ? "https://onlinetools.ups.com" : "https://wwwcie.ups.com";
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await fetch(`${baseUrl}/security/v1/oauth/token`, {
    method: "POST",
    headers: { Authorization: `Basic ${credentials}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
    signal: AbortSignal.timeout(20000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) throw new Error(`UPS OAuth failed (${response.status}): ${String(data.error_description || data.error || "authentication failed").slice(0, 160)}`);
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
  if (!shipment || !track) throw new HttpsError("not-found", "UPS returned no tracking details for this number.");
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
      carrierStatusCode: String(item.status?.code || "").slice(0, 24)
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
    events: events.slice(0, 50)
  };
}

async function callUpsTracking(trackingNumber, retryAfterUnauthorized = true) {
  const token = await getUpsAccessToken();
  const baseUrl = String(process.env.UPS_ENVIRONMENT || "sandbox").toLowerCase() === "production"
    ? "https://onlinetools.ups.com" : "https://wwwcie.ups.com";
  const response = await fetch(`${baseUrl}/api/track/v1/details/${encodeURIComponent(trackingNumber)}?locale=en_US&returnSignature=false`, {
    headers: { Authorization: `Bearer ${token}`, transId: crypto.randomUUID(), transactionSrc: "daboffoods-website" },
    signal: AbortSignal.timeout(25000)
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    tokenCache = { value: "", expiresAt: 0 };
    if (retryAfterUnauthorized) return callUpsTracking(trackingNumber, false);
    throw new HttpsError("unavailable", "UPS authorization expired. Please retry the tracking request.");
  }
  if (response.status === 404 || response.status === 400) throw new HttpsError("not-found", "UPS could not find a shipment with that tracking number.");
  if (!response.ok) {
    logger.error("UPS tracking API error", { status: response.status });
    throw new HttpsError("unavailable", "UPS tracking is temporarily unavailable.");
  }
  return extractUpsTracking(data);
}

function publicShipment(shipment, events) {
  return {
    shipmentId: shipment.shipmentId, orderId: shipment.orderId, carrier: shipment.carrier,
    trackingNumber: shipment.trackingNumber, origin: shipment.origin || "", destination: shipment.destination || "",
    shipmentStatus: shipment.shipmentStatus, estimatedDelivery: shipment.estimatedDelivery || null,
    createdAt: shipment.createdAt?.toDate ? shipment.createdAt.toDate().toISOString() : shipment.createdAt || null,
    updatedAt: shipment.updatedAt?.toDate ? shipment.updatedAt.toDate().toISOString() : shipment.updatedAt || null,
    events: events.map(event => ({ status: event.status, description: event.description,
      location: event.location || "", occurredAt: event.occurredAt?.toDate ? event.occurredAt.toDate().toISOString() : event.occurredAt || null }))
  };
}

async function rateLimitLookup(request) {
  const ip = String(request.rawRequest?.ip || request.rawRequest?.headers?.["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const key = crypto.createHash("sha256").update(ip).digest("hex");
  const ref = db.doc(`trackingLookupLimits/${key}`);
  const now = Date.now();
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const record = snap.exists ? snap.data() : {};
    const start = Number(record.windowStart || 0);
    const count = start + LOOKUP_WINDOW_MS > now ? Number(record.count || 0) : 0;
    if (count >= LOOKUP_LIMIT) throw new HttpsError("resource-exhausted", "Too many tracking requests. Please wait a minute and try again.");
    tx.set(ref, { windowStart: count ? start : now, count: count + 1, expiresAt: new Date(now + 2 * LOOKUP_WINDOW_MS) });
  });
}

async function getShipmentEvents(shipmentId) {
  const snap = await db.collection("trackingEvents").where("shipmentId", "==", shipmentId).limit(100).get();
  return snap.docs.map(doc => doc.data()).sort((a, b) => {
    const time = x => x.occurredAt?.toMillis ? x.occurredAt.toMillis() : new Date(x.occurredAt || 0).getTime();
    return time(b) - time(a);
  });
}

exports.trackUpsShipment = onCall({ secrets: [UPS_CLIENT_ID, UPS_CLIENT_SECRET] }, async request => {
  const user = requireUser(request);
  const shipmentId = String(request.data?.shipmentId || "").trim();
  if (!shipmentId) throw new HttpsError("invalid-argument", "shipmentId is required.");
  const ref = db.doc(`shipments/${shipmentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Shipment not found.");
  const shipment = snap.data();
  if (shipment.customerId !== user.uid) await requireAdmin(user.uid);
  if (String(shipment.carrier).toUpperCase() !== "UPS") throw new HttpsError("failed-precondition", "Live tracking is currently available only for UPS shipments.");
  if (!shipment.trackingNumber) throw new HttpsError("failed-precondition", "This shipment does not have a tracking number yet.");
  let result;
  try { result = await callUpsTracking(shipment.trackingNumber); }
  catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("UPS tracking request failed", { shipmentId, error: String(error.message || error) });
    throw new HttpsError("unavailable", "UPS tracking is temporarily unavailable. Please try again later.");
  }

  await db.runTransaction(async tx => {
    tx.update(ref, {
      shipmentStatus: result.shipmentStatus, estimatedDelivery: result.estimatedDelivery || null,
      latestUpdate: result.latestUpdate, origin: result.origin || shipment.origin || "",
      destination: result.destination || shipment.destination || "", updatedAt: FieldValue.serverTimestamp()
    });
    for (const event of result.events) {
      const key = crypto.createHash("sha256").update(`${shipmentId}|${event.occurredAt}|${event.description}|${event.location}`).digest("hex");
      const eventRef = db.doc(`trackingEvents/${key}`);
      tx.set(eventRef, {
        eventId: key, shipmentId, orderId: shipment.orderId, customerId: shipment.customerId,
        carrier: "UPS", ...event, source: "carrier-api", createdAt: FieldValue.serverTimestamp()
      }, { merge: true });
    }
  });
  const events = await getShipmentEvents(shipmentId);
  return publicShipment({ ...shipment, ...result, updatedAt: new Date() }, events);
});

exports.lookupShipment = onCall(async request => {
  const lookup = String(request.data?.trackingNumber || request.data?.orderId || "").trim();
  if (!/^[A-Za-z0-9-]{5,80}$/.test(lookup)) throw new HttpsError("invalid-argument", "Enter a valid tracking number or order reference.");
  await rateLimitLookup(request);
  let shipmentSnap = null;
  const matches = await db.collection("shipments").where("trackingNumber", "==", lookup).limit(1).get();
  if (!matches.empty) shipmentSnap = matches.docs[0];
  if (!shipmentSnap && /^[A-Za-z0-9-]{4,80}$/.test(lookup)) {
    const orderSnap = await db.doc(`orders/${lookup}`).get();
    if (orderSnap.exists) {
      const order = orderSnap.data();
      const orderId = orderSnap.id;
      const shipments = await db.collection("shipments").where("orderId", "==", orderId).limit(1).get();
      if (!shipments.empty) shipmentSnap = shipments.docs[0];
      else {
        const locationSnap = await db.doc(`riderLocations/${orderId}`).get();
        const location = locationSnap.exists && locationSnap.data().active ? locationSnap.data() : null;
        return {
          shipmentId: null, orderId, carrier: "Manual / not assigned", trackingNumber: orderId,
          origin: "", destination: "", shipmentStatus: order.status || "Order Placed",
          estimatedDelivery: null, createdAt: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : order.createdAt || null,
          updatedAt: order.updatedAt?.toDate ? order.updatedAt.toDate().toISOString() : order.updatedAt || null,
          latestUpdate: order.status || "Order Placed",
          events: (order.statusHistory || []).map(event => ({ status: event.status, description: event.status,
            location: "", occurredAt: event.at?.toDate ? event.at.toDate().toISOString() : event.at || null })),
          liveLocation: location ? { lat: Number(location.lat), lng: Number(location.lng), ts: Number(location.ts || 0), riderName: String(location.riderName || "Your rider").slice(0, 80), active: true } : null
        };
      }
    }
  }
  if (!shipmentSnap) throw new HttpsError("not-found", "Shipment not found. Check the tracking number and try again.");
  const shipment = shipmentSnap.data();
  const events = await getShipmentEvents(shipmentSnap.id);
  const result = publicShipment({ shipmentId: shipmentSnap.id, ...shipment }, events);
  const locationSnap = shipment.orderId ? await db.doc(`riderLocations/${shipment.orderId}`).get() : null;
  const location = locationSnap?.exists && locationSnap.data().active ? locationSnap.data() : null;
  result.orderId = shipment.orderId || null;
  result.liveLocation = location ? { lat: Number(location.lat), lng: Number(location.lng), ts: Number(location.ts || 0), riderName: String(location.riderName || "Your rider").slice(0, 80), active: true } : null;
  return result;
});

exports.createShipment = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const orderId = cleanString(request.data?.orderId, "orderId", 80);
  const carrier = cleanString(request.data?.carrier, "carrier", 40);
  const trackingNumber = cleanString(request.data?.trackingNumber, "trackingNumber", 80);
  const origin = cleanString(request.data?.origin, "origin", 180);
  const destination = cleanString(request.data?.destination, "destination", 180);
  const allowedCarriers = ["UPS", "DHL", "FedEx", "Other / Manual Carrier"];
  if (!allowedCarriers.includes(carrier)) throw new HttpsError("invalid-argument", "Unsupported carrier.");
  const orderRef = db.doc(`orders/${orderId}`);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw new HttpsError("not-found", "Order not found.");
  const shipmentRef = db.collection("shipments").doc();
  const initialStatus = String(request.data?.shipmentStatus || "Shipment Registered");
  if (!statusAllowed(initialStatus)) throw new HttpsError("invalid-argument", "Invalid initial shipment status.");
  const estimatedDelivery = safeDate(request.data?.estimatedDelivery);
  const eventKey = crypto.createHash("sha256").update(`${shipmentRef.id}|${initialStatus}|${trackingNumber}|created`).digest("hex");
  await db.runTransaction(async tx => {
    const freshOrder = await tx.get(orderRef);
    if (!freshOrder.exists) throw new HttpsError("not-found", "Order not found.");
    const latestOrder = freshOrder.data();
    if (latestOrder.status === "Cancelled") throw new HttpsError("failed-precondition", "A cancelled order cannot be shipped.");
    if (latestOrder.paymentOption !== "Cash on delivery" && latestOrder.paymentStatus !== "Paid") {
      throw new HttpsError("failed-precondition", "Prepaid orders must have a verified payment before shipment registration.");
    }
    tx.create(shipmentRef, {
      shipmentId: shipmentRef.id, orderId, customerId: latestOrder.customerUid || null,
      carrier, trackingNumber, origin, destination, shipmentStatus: initialStatus,
      estimatedDelivery, latestUpdate: "Shipment registered", createdBy: auth.uid,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp()
    });
    tx.create(db.doc(`trackingEvents/${eventKey}`), {
      eventId: eventKey, shipmentId: shipmentRef.id, orderId, customerId: latestOrder.customerUid || null,
      carrier, status: initialStatus, description: "Shipment registered", location: origin,
      occurredAt: FieldValue.serverTimestamp(), source: "admin", adminUid: auth.uid,
      createdAt: FieldValue.serverTimestamp()
    });
  });
  return { shipmentId: shipmentRef.id };
});

exports.addTrackingEvent = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const shipmentId = cleanString(request.data?.shipmentId, "shipmentId", 100);
  const status = cleanString(request.data?.status, "status", 60);
  const description = cleanString(request.data?.description, "description", 300);
  const location = String(request.data?.location || "").trim().slice(0, 180);
  if (!statusAllowed(status)) throw new HttpsError("invalid-argument", "Unsupported shipment status.");
  const occurredAt = safeDate(request.data?.occurredAt) || new Date();
  const ref = db.doc(`shipments/${shipmentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Shipment not found.");
  const shipment = snap.data();
  const eventKey = crypto.createHash("sha256").update(`${shipmentId}|${status}|${description}|${location}|${occurredAt.toISOString()}`).digest("hex");
  const eventRef = db.doc(`trackingEvents/${eventKey}`);
  let duplicate = false;
  await db.runTransaction(async tx => {
    const [fresh, existing] = await Promise.all([tx.get(ref), tx.get(eventRef)]);
    if (!fresh.exists) throw new HttpsError("not-found", "Shipment not found.");
    if (!existing.exists) tx.create(eventRef, {
      eventId: eventKey, shipmentId, orderId: shipment.orderId, customerId: shipment.customerId || null,
      carrier: shipment.carrier, status, description, location, occurredAt,
      source: "admin", adminUid: auth.uid, createdAt: FieldValue.serverTimestamp()
    });
    else duplicate = true;
    tx.update(ref, { shipmentStatus: status, latestUpdate: description, updatedAt: FieldValue.serverTimestamp() });
  });
  return { eventId: eventKey, duplicate };
});

exports.updateShipment = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const shipmentId = cleanString(request.data?.shipmentId, "shipmentId", 100);
  const ref = db.doc(`shipments/${shipmentId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Shipment not found.");
  const updates = {};
  for (const key of ["carrier", "trackingNumber", "origin", "destination"]) {
    if (request.data?.[key] !== undefined) updates[key] = cleanString(request.data[key], key, 180);
  }
  const allowedCarriers = ["UPS", "DHL", "FedEx", "Other / Manual Carrier"];
  if (updates.carrier && !allowedCarriers.includes(updates.carrier)) throw new HttpsError("invalid-argument", "Unsupported carrier.");
  if (request.data?.estimatedDelivery !== undefined) updates.estimatedDelivery = safeDate(request.data.estimatedDelivery);
  if (request.data?.shipmentStatus !== undefined) {
    updates.shipmentStatus = cleanString(request.data.shipmentStatus, "shipmentStatus", 60);
    if (!statusAllowed(updates.shipmentStatus)) throw new HttpsError("invalid-argument", "Unsupported shipment status.");
  }
  updates.updatedAt = FieldValue.serverTimestamp();
  const eventRef = db.collection("trackingEvents").doc();
  await db.runTransaction(async tx => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) throw new HttpsError("not-found", "Shipment not found.");
    const current = fresh.data();
    if (updates.shipmentStatus && updates.shipmentStatus !== current.shipmentStatus) {
      tx.create(eventRef, {
        eventId: eventRef.id, shipmentId, orderId: current.orderId, customerId: current.customerId || null,
        carrier: updates.carrier || current.carrier, status: updates.shipmentStatus,
        description: `Shipment status updated to ${updates.shipmentStatus}`,
        location: String(request.data?.location || "").trim().slice(0, 180),
        occurredAt: FieldValue.serverTimestamp(), source: "admin", adminUid: auth.uid,
        createdAt: FieldValue.serverTimestamp()
      });
    }
    tx.update(ref, updates);
  });
  return { ok: true };
});

exports.adminListPayments = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const limit = Math.min(250, Math.max(1, Number(request.data?.limit) || 100));
  const snap = await db.collection("payments").orderBy("createdAt", "desc").limit(limit).get();
  return { payments: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) };
});

exports.adminListShipments = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const limit = Math.min(300, Math.max(1, Number(request.data?.limit) || 150));
  const snap = await db.collection("shipments").orderBy("createdAt", "desc").limit(limit).get();
  return { shipments: snap.docs.map(doc => ({ shipmentId: doc.id, ...doc.data() })) };
});

exports.linkOrderToCustomer = onCall(async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  const orderId = cleanString(request.data?.orderId, "orderId", 80);
  const customerId = cleanString(request.data?.customerId, "customerId", 128);
  const userRecord = await getAuth().getUser(customerId).catch(() => null);
  if (!userRecord) throw new HttpsError("not-found", "Firebase Authentication user not found.");
  const profileSnap = await db.doc(`users/${customerId}`).get();
  if (!profileSnap.exists || profileSnap.data().role !== "customer" || profileSnap.data().disabled) {
    throw new HttpsError("failed-precondition", "Select an active customer profile.");
  }
  const ref = db.doc(`orders/${orderId}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Order not found.");
    if (snap.data().customerUid && snap.data().customerUid !== customerId) throw new HttpsError("failed-precondition", "This order is already linked to another customer.");
    tx.update(ref, { customerUid: customerId, customerEmail: userRecord.email || snap.data().customerEmail || "", updatedAt: FieldValue.serverTimestamp() });
  });
  return { ok: true };
});

exports.listMyShipments = onCall(async request => {
  const user = requireUser(request);
  const snap = await db.collection("shipments").where("customerId", "==", user.uid).limit(100).get();
  const records = await Promise.all(snap.docs.map(async doc => {
    const data = doc.data();
    return publicShipment({ shipmentId: doc.id, ...data }, await getShipmentEvents(doc.id));
  }));
  records.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return { shipments: records };
});

/* ---------------- Admin: promote existing user to admin (role only) ----------------
   Trusted server-side promotion. Caller MUST already be an active admin
   (Firestore users/{callerUid}.role === "admin"). The target must be an
   existing Firebase Auth user with an existing Firestore profile; this
   function never creates an account and never allows self-promotion:
   a non-admin caller is rejected by requireAdmin(), and an admin cannot
   change their own role via this endpoint. Firestore rules separately
   forbid non-admins from writing role/disabled on users/{uid}, so the
   client cannot bypass this. No custom claims are used (Firestore roles
   only, per firestore.rules isAdmin()). */
exports.promoteToAdmin = onCall(async request => {
  const caller = requireUser(request);
  await requireAdmin(caller.uid);
  const targetUid = cleanString(request.data?.targetUid, "targetUid", 128);
  if (targetUid === caller.uid) {
    throw new HttpsError("failed-precondition", "You are already an admin. Self-promotion is not allowed.");
  }
  const userRecord = await getAuth().getUser(targetUid).catch(() => null);
  if (!userRecord) throw new HttpsError("not-found", "Firebase Authentication user not found.");
  const ref = db.doc(`users/${targetUid}`);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "User profile not found. Ask the user to sign in once first.");
  const before = snap.data();
  if (before.role === "admin" && before.disabled !== true) return { ok: true, alreadyAdmin: true, uid: targetUid };
  await ref.update({ role: "admin", disabled: false, updatedAt: FieldValue.serverTimestamp() });
  const after = (await ref.get()).data();
  if (after.role !== "admin" || after.disabled === true) throw new HttpsError("internal", "Promotion did not verify.");
  return { ok: true, uid: targetUid, email: userRecord.email || before.email || "" };
});

exports.getUpsAccessToken = onCall({ secrets: [UPS_CLIENT_ID, UPS_CLIENT_SECRET] }, async request => {
  const auth = requireUser(request);
  await requireAdmin(auth.uid);
  try {
    await getUpsAccessToken();
    return { ready: true }; // Never return the bearer token to a browser.
  } catch (error) {
    logger.error("UPS OAuth connectivity check failed", { error: String(error.message || error) });
    throw new HttpsError("unavailable", "UPS authentication is unavailable. Check Functions secret configuration.");
  }
});
