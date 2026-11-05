// POST /api/admin/payments  { action: "list" }  → { payments: [...] }
// Auth: active administrator only. Mirrors `adminListPayments`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, parseBody, send, errorResponse, requireAdmin } = require("../_lib/auth");

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const user = await verifyCaller(req, adm);
    await requireAdmin(db, user.uid);
    const body = parseBody(req);
    const limit = Math.min(250, Math.max(1, Number(body.limit) || 100));
    const snap = await db.collection("payments").orderBy("createdAt", "desc").limit(limit).get();
    return send(res, 200, { payments: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
  } catch (err) {
    return errorResponse(res, err);
  }
}
