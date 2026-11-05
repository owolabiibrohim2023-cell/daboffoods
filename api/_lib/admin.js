// Shared Firebase Admin SDK initialization for Vercel Serverless Functions.
// Reads EXACTLY ONE of these (first match wins); values live ONLY in
// Vercel environment variables — never in frontend or repo code:
//   1. FIREBASE_SERVICE_ACCOUNT_KEY  (full service-account JSON, string)
//   2. FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY
//      (legacy split vars, still supported)
//   3. GOOGLE_APPLICATION_CREDENTIALS (path to a key file, local dev)
const fs = require("node:fs");
let admin;
try { admin = require("firebase-admin"); } catch { admin = null; }

function notConfigured(message) {
  return Object.assign(new Error(message), { status: 500, code: "not-configured" });
}

function parseKeyJson(raw, label) {
  let obj;
  try {
    obj = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw notConfigured(`${label} is not valid JSON.`);
  }
  if (!obj || obj.type !== "service_account" || !obj.client_email || !obj.private_key) {
    throw notConfigured(`${label} does not look like a service-account key (needs type, client_email, private_key).`);
  }
  return obj;
}

function getAdmin() {
  if (!admin) throw notConfigured("firebase-admin is not installed on the server.");
  if (admin.apps.length) return admin;

  let credential = null;
  const serviceAccountKey = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY || "";

  if (serviceAccountKey) {
    const key = parseKeyJson(serviceAccountKey, "FIREBASE_SERVICE_ACCOUNT_KEY");
    credential = admin.credential.cert(key);
  } else if (projectId && clientEmail && privateKey) {
    privateKey = String(privateKey).replace(/\\n/g, "\n");
    credential = admin.credential.cert({ projectId, clientEmail, privateKey });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
    credential = admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
  }

  if (!credential) {
    throw notConfigured(
      "Firebase Admin credentials are not configured. Set FIREBASE_SERVICE_ACCOUNT_KEY (full service-account JSON) in Vercel environment variables."
    );
  }
  admin.initializeApp({ credential });
  return admin;
}

module.exports = { getAdmin };
