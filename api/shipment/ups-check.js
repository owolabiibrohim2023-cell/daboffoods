// POST /api/shipment/ups-check  {}  → { ready: true } (never returns the token)
// Auth: active administrator only. Mirrors `getUpsAccessToken`.
const { getAdmin } = require("../_lib/admin");
const { verifyCaller, send, errorResponse, httpError, requireAdmin } = require("../_lib/auth");
const { getUpsAccessToken } = require("../_lib/ups");

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return send(res, 204, {});
  if (req.method !== "POST") return send(res, 405, { error: "method-not-allowed" });
  try {
    const adm = getAdmin();
    const db = adm.firestore();
    const user = await verifyCaller(req, adm);
    await requireAdmin(db, user.uid);
    try {
      await getUpsAccessToken();
      return send(res, 200, { ready: true });
    } catch (error) {
      console.error("UPS OAuth connectivity check failed", { error: String(error.message || error) });
      throw httpError(503, "unavailable", "UPS authentication is unavailable. Check the server UPS credentials.");
    }
  } catch (err) {
    return errorResponse(res, err);
  }
}
