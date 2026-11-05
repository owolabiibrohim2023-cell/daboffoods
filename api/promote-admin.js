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
//   FIREBASE_SERVICE_ACCOUNT_KEY (full service-account JSON), or
//   FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//   (service-account key with Firebase Auth Admin + Datastore User)
// ============================================================

const { getAdmin } = require("./_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, httpError, requireAdmin } = require("./_lib/auth");

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const FieldValue = adm.firestore.FieldValue;

    // 1) Verify caller identity (server-side, trusted).
    const caller = await verifyCaller(req, adm);
    const callerUid = caller.uid;

    // 2) Caller MUST be an active admin (Firestore role model).
    await requireAdmin(db, callerUid);

    const body = parseBody(req);
    const targetUid = String(body.targetUid || "").trim();
    const action = String(body.action || "promote").trim().toLowerCase();
    if (!targetUid || targetUid.length > 128) throw httpError(400, "invalid-argument", "targetUid is required.");
    if (!["promote", "demote"].includes(action)) throw httpError(400, "invalid-argument", "action must be promote or demote.");

    // 4) No self role changes.
    if (targetUid === callerUid) {
      throw httpError(400, "failed-precondition", "You cannot change your own role. Ask another admin.");
    }

    // 3) Target must be an existing Auth user + existing profile. Never create.
    const userRecord = await adm.auth().getUser(targetUid).catch(() => null);
    if (!userRecord) throw httpError(404, "not-found", "Firebase Authentication user not found.");
    const ref = db.doc(`users/${targetUid}`);
    const snap = await ref.get();
    if (!snap.exists) throw httpError(404, "not-found", "User profile not found. Ask the user to sign in once first.");
    const before = snap.data();

    if (action === "demote") {
      if (before.role !== "admin") return send(res, 200, { ok: true, alreadyCustomer: true, uid: targetUid });
      await ref.update({ role: "customer", updatedAt: FieldValue.serverTimestamp() });
    } else {
      if (before.role === "admin" && before.disabled !== true) return send(res, 200, { ok: true, alreadyAdmin: true, uid: targetUid });
      await ref.update({ role: "admin", disabled: false, updatedAt: FieldValue.serverTimestamp() });
    }

    // Verify write.
    const after = (await ref.get()).data();
    const expected = action === "promote" ? "admin" : "customer";
    if (after.role !== expected) throw httpError(500, "internal", "Role change did not verify.");

    return send(res, 200, { ok: true, uid: targetUid, email: userRecord.email || before.email || "", role: after.role, action });
  } catch (err) {
    return errorResponse(res, err);
  }
}
