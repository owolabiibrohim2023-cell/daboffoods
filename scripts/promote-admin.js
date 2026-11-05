/**
 * promote-admin.js — One-off trusted script to promote ONE existing user to admin.
 *
 * What it does:
 *   1. Verifies the target user EXISTS in Firebase Authentication.
 *   2. Verifies users/{uid} in Firestore has email === daboffoods@gmail.com.
 *   3. Updates ONLY { role: "admin", disabled: false, updatedAt } on that doc.
 *   4. Re-reads the doc and prints the result.
 *
 * It does NOT create an account, does NOT touch custom claims (this project
 * uses Firestore roles only — see firestore.rules isAdmin()), and does NOT
 * modify any other field or any other user.
 *
 * Credentials: uses Application Default Credentials (ADC). Provide a
 * service-account key via ONE of:
 *   - GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json
 *   - a file named service-account.json in THIS scripts/ folder (gitignored)
 *   - gcloud application-default login (creates ADC automatically)
 *
 * Usage:
 *   node scripts/promote-admin.js
 *   node scripts/promote-admin.js aR46fqrmFifk6WfcKyOChtLkDqq1
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PROJECT_ID = "fl-logistics-ce201";
const TARGET_UID = process.argv[2] || "aR46fqrmFifk6WfcKyOChtLkDqq1";
const EXPECTED_EMAIL = "daboffoods@gmail.com";

async function main() {
  // Load firebase-admin from functions/node_modules if present, else local.
  let admin;
  try {
    admin = require("firebase-admin");
  } catch {
    try {
      admin = require(path.join(__dirname, "..", "functions", "node_modules", "firebase-admin"));
    } catch {
      console.error(
        "ERROR: firebase-admin is not installed. Run:\n" +
          "  cmd /c \"cd functions && npm install\"\n" +
          "then re-run this script."
      );
      process.exit(1);
    }
  }

  // Resolve credentials: explicit key file next to this script, else ADC.
  const localKey = path.join(__dirname, "service-account.json");
  if (fs.existsSync(localKey)) {
    const credential = admin.credential.cert(localKey);
    admin.initializeApp({ credential, projectId: PROJECT_ID });
    console.log("Using service-account.json from scripts/ folder.");
  } else {
    try {
      admin.initializeApp({ projectId: PROJECT_ID }); // ADC via env var / gcloud / metadata
      console.log(
        "Using Application Default Credentials" +
          (process.env.GOOGLE_APPLICATION_CREDENTIALS
            ? ` (${process.env.GOOGLE_APPLICATION_CREDENTIALS})`
            : " (gcloud application-default login)") +
          "."
      );
    } catch (e) {
      console.error(
        "ERROR: No credentials found. Provide one of:\n" +
          "  1) Set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON key path, or\n" +
          "  2) Save a service-account JSON key as scripts/service-account.json (gitignored), or\n" +
          "  3) Run: gcloud auth application-default login\n\n" +
          "Original error: " + e.message
      );
      process.exit(1);
    }
  }

  const auth = admin.auth();
  const db = admin.firestore();
  const ref = db.doc(`users/${TARGET_UID}`);

  // 1) Confirm the Auth user exists and matches the expected email.
  let userRecord;
  try {
    userRecord = await auth.getUser(TARGET_UID);
  } catch (e) {
    console.error(`ERROR: No Firebase Auth user found for UID ${TARGET_UID}: ${e.message}`);
    process.exit(1);
  }
  console.log(`Auth user found: ${userRecord.email} (uid ${userRecord.uid})`);
  if ((userRecord.email || "").toLowerCase() !== EXPECTED_EMAIL) {
    console.error(
      `ABORT: Auth email ${userRecord.email} does not match expected ${EXPECTED_EMAIL}. Refusing to promote.`
    );
    process.exit(1);
  }

  // 2) Confirm the Firestore profile exists and matches the expected email.
  const snap = await ref.get();
  if (!snap.exists) {
    console.error(`ERROR: Firestore doc users/${TARGET_UID} does not exist. Aborting (not creating it).`);
    process.exit(1);
  }
  const before = snap.data();
  console.log(`Current Firestore profile: role=${before.role} disabled=${before.disabled} email=${before.email}`);
  if ((before.email || "").toLowerCase() !== EXPECTED_EMAIL) {
    console.error(
      `ABORT: Firestore email ${before.email} does not match expected ${EXPECTED_EMAIL}. Refusing to promote.`
    );
    process.exit(1);
  }
  if (before.role === "admin" && before.disabled !== true) {
    console.log("Already an active admin. Nothing to do.");
    return;
  }

  // 3) Promote: role only (+ disabled=false, updatedAt). Nothing else changes.
  await ref.update({
    role: "admin",
    disabled: false,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`Updated users/${TARGET_UID}: role -> admin, disabled -> false`);

  // 4) Verify by re-reading.
  const after = (await ref.get()).data();
  console.log(`Verified: role=${after.role} disabled=${after.disabled} email=${after.email}`);
  if (after.role === "admin" && after.disabled !== true) {
    console.log(
      "SUCCESS. Sign out and sign in again as daboffoods@gmail.com, then open admin.html."
    );
  } else {
    console.error("ERROR: Verification failed — role is not admin.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("ERROR:", e.message);
  process.exit(1);
});
