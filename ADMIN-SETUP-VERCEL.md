# Admin setup on Vercel (no Cloud Functions, no billing upgrade)

## Why daboffoods@gmail.com was denied
- Admin check: `users/{uid}.role === "admin"` and `disabled !== true` (firestore.rules `isAdmin()`, admin.js:57).
- `daboffoods@gmail.com` UID `aR46fqrmFifk6WfcKyOChtLkDqq1` was auto-created as `role: "customer"` on first sign-in (auth.js `ensureUserProfile`). Customer role = denied.

## What changed
- NEW `api/promote-admin.js` (Vercel Serverless): verifies caller ID token + admin role server-side, then promotes/demotes an EXISTING user only. No self-promotion. No account creation. No custom claims. No Cloud Functions.
- `admin.js`: "Make admin" / "Remove admin" buttons now call `POST /api/promote-admin` with the caller's Firebase ID token (previously called the Cloud Functions callable `promoteToAdmin`).
- `package.json`: adds `firebase-admin` for the Vercel function.
- `vercel.json`: sets function timeout.
- Untouched: Firebase Auth, Firestore rules, customer login, admin dashboard gate. Existing Cloud Functions code for payments/shipping/alerts is left as-is and is NOT required for admin authorization.

## Setup (you do this once)
1. Firebase Console → Project Settings → Service accounts → Generate key (JSON). The account needs Firebase Auth Admin + Datastore User (Owner works).
2. Vercel Dashboard → your project → Settings → Environment Variables (Production + Preview):
   - `FIREBASE_PROJECT_ID` = `fl-logistics-ce201`
   - `FIREBASE_CLIENT_EMAIL` = the `client_email` from the key JSON
   - `FIREBASE_PRIVATE_KEY` = the full `private_key` value INCLUDING `-----BEGIN PRIVATE KEY-----` ... `-----END PRIVATE KEY-----`
3. Redeploy on Vercel (push or "Redeploy").
4. Browser: open `admin.html` → sign in as CURRENT admin → Customers tab → search `daboffoods@gmail.com` → **Make admin** → Yes.
   - Target UID `aR46fqrmFifk6WfcKyOChtLkDqq1` is verified server-side via Admin SDK `getUser()`.
5. Sign out → sign in as `daboffoods@gmail.com` → open `admin.html` → dashboard loads.
6. Test: sign in as a normal customer → `admin.html` shows Access denied; calling `/api/promote-admin` returns 403.
7. Optional: set your first Gmail's role back to `customer` via **Remove admin** (another admin must do it — no self-demotion). Keep at least one admin at all times.
8. Delete or restrict the service-account key after setup if desired; keep the Vercel env vars until you no longer need role changes.

## Security notes
- The private key lives ONLY in Vercel env vars. It is never in frontend code (`app.js`/`admin.js` only contain the public web API key).
- Firestore rules already forbid non-admins from writing `role`/`disabled`, so customers cannot self-promote even if they call the endpoint directly (server returns 403).
- Admin dashboard gate in `admin.js` is UX only; real enforcement is Firestore rules + this server endpoint.
