// Server-side auth + response helpers for Vercel handlers.
// EVERY protected endpoint must call verifyCaller() and then either
// requireAdmin() or an explicit ownership check. Frontend checks alone
// are never trusted.
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function send(res, status, body) {
  cors(res);
  res.status(status).json(body);
}

function parseBody(req) {
  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  return body && typeof body === "object" ? body : {};
}

function cleanString(value, name, maxLength = 180) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength) {
    throw httpError(400, "invalid-argument", `${name} is required and must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function errorResponse(res, err) {
  console.error("API error:", err && err.message ? err.message : err);
  const status = err && err.status ? err.status : 500;
  const code = err && err.code ? err.code : "internal";
  const message = err && err.code === "not-configured"
    ? "Server credentials are not configured yet."
    : (err && err.message ? err.message : "Something went wrong. Check the function logs.");
  send(res, status, { error: code, message });
}

async function verifyCaller(req, adm) {
  const header = String(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) throw httpError(401, "unauthenticated", "Please sign in first.");
  try {
    const decoded = await adm.auth().verifyIdToken(token);
    if (!decoded || !decoded.uid) throw httpError(401, "unauthenticated", "Please sign in again.");
    return { uid: decoded.uid };
  } catch (err) {
    throw httpError(401, "unauthenticated", "Invalid or expired token. Please sign in again.");
  }
}

async function getProfile(db, uid) {
  const snap = await db.doc(`users/${uid}`).get();
  return snap.exists ? snap.data() : null;
}

async function requireAdmin(db, uid) {
  const profile = await getProfile(db, uid);
  if (!profile || profile.role !== "admin" || profile.disabled === true) {
    throw httpError(403, "permission-denied", "Administrator access is required.");
  }
  return profile;
}

module.exports = { httpError, cors, send, parseBody, cleanString, errorResponse, verifyCaller, getProfile, requireAdmin };
