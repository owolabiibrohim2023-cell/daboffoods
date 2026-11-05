// ============================================================
//  api/promote-admin.js — Vercel Serverless Function (NO Cloud Functions)
//  POST /api/promote-admin  { targetUid, action: "promote" | "demote" }
//  Header: Authorization: Bearer <Firebase ID token of caller>
//
//  Server-side authorization chain:
//   1. Verify caller's Firebase ID token with Admin SDK (verifyIdToken).
//   2. Read users/{callerUid} with Admin SDK; caller MUST have
//      role === "admin" and disabled !== true. Otherwise 403.
//   3. Target must be an EXISTING Firebase Auth user AND have an
//      existing Firestore profile. No account is ever created.
//   4. Caller cannot change their OWN role (no self-promotion/demotion).
//   5. Only role/disabled/updatedAt are written. Nothing else changes.
//  Firestore Security Rules independently forbid non-admins from
//  writing role/disabled, so a client cannot bypass this endpoint.
//  No Firebase custom claims are used (Firestore role model only).
//
//  Required Vercel env vars (set in Vercel Dashboard, never in code):
//   FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
//   (service-account key with Firebase Auth Admin + Datastore User)
// ============================================================

let admin;
try { admin = require("firebase-admin"); } catch { admin = null; }

function getAdmin() {
  if (!admin) throw Object.assign(new Error("firebase-admin not installed"), { status: 500, code: "not-configured" });
  if (!admin.apps.length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";
    if (!projectId || !clientEmail || !privateKey) {
      throw Object.assign(new Error("Firebase Admin env vars missing on Vercel"), { status: 500, code: "not-configured" });
    }
    privateKey = privateKey.replace(/\\n/g, "\n");
    admin.initializeApp({ credential: admin.credential.cert({ projectId, clientEmail, privateKey }) });
  }
  return admin;
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}
function send(res, status, body) { cors(res); res.status(status).json(body); }

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });

  try {
    const adm = getAdmin();
    const auth = adm.auth();
    const db = adm.firestore();

    // 1) Verify caller identity (server-side, trusted).
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return send(res, 401, { error: "unauthenticated", message: "Sign in required." });
    let decoded;
    try { decoded = await auth.verifyIdToken(token); }
    catch { return send(res, 401, { error: "unauthenticated", message: "Invalid or expired token. Sign in again." }); }
    const callerUid = decoded.uid;

    // 2) Caller MUST be an active admin (Firestore role model).
    const callerSnap = await db.doc(`users/${callerUid}`).get();
    const caller = callerSnap.exists ? callerSnap.data() : null;
    if (!caller || caller.role !== "admin" || caller.disabled === true) {
      return send(res, 403, { error: "permission-denied", message: "Administrator access is required." });
    }

    // Parse body (Vercel provides req.body, but handle raw string too).
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    const targetUid = String(body.targetUid || "").trim();
    const action = String(body.action || "promote").trim().toLowerCase();
    if (!targetUid || targetUid.length > 128) return send(res, 400, { error: "invalid-argument", message: "targetUid is required." });
    if (!["promote", "demote"].includes(action)) return send(res, 400, { error: "invalid-argument", message: "action must be promote or demote." });

    // 4) No self role changes.
    if (targetUid === callerUid) {
      return send(res, 400, { error: "failed-precondition", message: "You cannot change your own role. Ask another admin." });
    }

    // 3) Target must be an existing Auth user + existing profile. Never create.
    const userRecord = await auth.getUser(targetUid).catch(() => null);
    if (!userRecord) return send(res, 404, { error: "not-found", message: "Firebase Authentication user not found." });
    const ref = db.doc(`users/${targetUid}`);
    const snap = await ref.get();
    if (!snap.exists) return send(res, 404, { error: "not-found", message: "User profile not found. Ask the user to sign in once first." });
    const before = snap.data();

    if (action === "demote") {
      if (before.role !== "admin") return send(res, 200, { ok: true, alreadyCustomer: true, uid: targetUid });
      await ref.update({ role: "customer", updatedAt: adm.firestore.FieldValue.serverTimestamp() });
    } else {
      if (before.role === "admin" && before.disabled !== true) return send(res, 200, { ok: true, alreadyAdmin: true, uid: targetUid });
      await ref.update({ role: "admin", disabled: false, updatedAt: adm.firestore.FieldValue.serverTimestamp() });
    }

    // Verify write.
    const after = (await ref.get()).data();
    const expected = action === "promote" ? "admin" : "customer";
    if (after.role !== expected) return send(res, 500, { error: "internal", message: "Role change did not verify." });

    return send(res, 200, { ok: true, uid: targetUid, email: userRecord.email || before.email || "", role: after.role, action });
  } catch (err) {
    console.error("promote-admin error:", err);
    if (err && err.code === "not-configured") return send(res, 500, { error: "not-configured", message: "Server admin credentials are not configured yet." });
    return send(res, err.status || 500, { error: "internal", message: "Something went wrong. Check Vercel function logs." });
  }
}

