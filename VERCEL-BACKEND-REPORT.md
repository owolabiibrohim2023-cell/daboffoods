# DABOFFOODS — Vercel Backend Report (no Cloud Functions)

Date: 2026-11-05. Firebase Auth + Firestore kept; Cloud Functions is no longer used by the website. All backend operations now run as Vercel Serverless Functions under `api/` with the Firebase Admin SDK.

## Files created
- `api/_lib/admin.js` — Admin SDK init from `FIREBASE_SERVICE_ACCOUNT_KEY` (full JSON) or legacy split vars / `GOOGLE_APPLICATION_CREDENTIALS` (local). Credentials only from env vars.
- `api/_lib/auth.js` — `verifyCaller` (ID-token verify), `requireAdmin`, validation + response helpers.
- `api/_lib/paystack.js` — Paystack request/verify + idempotent `settleVerifiedPayment` (mirrors `functions/payments.js`).
- `api/_lib/ups.js` — UPS OAuth (in-memory token cache, never returned), tracking API, status normalization.
- `api/_lib/shipping.js`, `api/_lib/client.js` (`apiCall`, replaces `httpsCallable`).
- `api/payments/initialize.js` — POST {orderId} → {authorizationUrl, reference}. Monthly: also mirrors `initializePaystackPayment`.
- `api/payments/verify.js` — POST {reference} → settle. Mirrors `verifyPaystackPayment`.
- `api/payments/cod-collect.js` — POST {orderId} (admin only). Mirrors `recordCodCollection`.
- `api/payments/order-status.js` — POST {orderId, status} (admin only, audited). Mirrors `adminUpdateOrderStatus`.
- `api/webhooks/paystack.js` — POST raw webhook, HMAC-SHA512 timing-safe, idempotent. Mirrors `paystackWebhook`.
- `api/shipment/lookup.js` — POST {trackingNumber|orderId}, public + IP rate-limited + sanitized. Mirrors `lookupShipment`.
- `api/shipment/mine.js` — POST {} → caller's shipments. Mirrors `listMyShipments`.
- `api/shipment/ups-refresh.js` — POST {shipmentId} (owner or admin). Mirrors `trackUpsShipment`.
- `api/shipment/ups-check.js` — POST {} → {ready:true} (admin only, no token leak). Mirrors `getUpsAccessToken`.
- `api/admin/shipments.js` — POST {action: create|update|add-event|list}. Mirrors `createShipment` / `updateShipment` / `addTrackingEvent` / `adminListShipments`.
- `api/admin/payments.js` — POST {action:"list"} OR {action:"link-order", orderId, customerId}. Mirrors `adminListPayments` + `linkOrderToCustomer`. Merged into one function to fit the 12-function Hobby limit (former `api/admin/link-order.js` removed).
- `api/promote-admin.js` — refactored to shared lib (same behaviour).

## Files modified
- `account.html`, `admin.js`, `track.js` — removed `firebase-functions` imports; all backend calls now use `apiCall`.
- `vercel.json` — function timeouts for all `api/**` (30s; webhook 60s).

## Environment variables (Vercel Dashboard → Settings → Environment Variables)
| Variable | Required for | Notes |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_KEY` | ALL endpoints | **Full service-account JSON** of project `fl-logistics-ce201` ( Firebase Console → Project settings → Service accounts → Generate key ). Roles: Firebase Auth Admin + Datastore User. Paste the entire JSON as ONE env var value. |
| `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | alternative to the JSON above | Legacy split vars — still supported. Private key must include the full PEM block. |
| `PAYSTACK_SECRET_KEY` | payments + webhook | Paystack secret (`sk_test_…` for testing). Never in frontend code. |
| `PAYSTACK_PUBLIC_KEY` | **not used server-side** | Public key — only used if you ever add Paystack Inline; the current checkout is server-initialized, so it is not needed. Safe to leave unset. |
| `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET` | UPS tracking | UPS Developer app credentials (OAuth). Tokens are cached in memory only. |
| `SITE_URL` | payment redirect | Your live domain, e.g. `https://daboffoods.vercel.app` (or your custom domain). Used to build the Paystack `callback_url`; validated server-side against its own host. |
| `UPS_ENVIRONMENT` | UPS | `sandbox` for testing, `production` for live. |

No Firebase billing / Blaze upgrade is needed for the Vercel backend. Firestore rules are unchanged (payments/shipments/trackingEvents remain write-denied to clients).

## Deploy steps (you do these)
1. Push the repo to your Vercel project (or `vercel` CLI from the project root). Vercel auto-detects `api/` functions.
2. In the Vercel Dashboard, add ALL env vars above (Production + Preview), then **Redeploy**.
3. Paystack dashboard → Settings → Webhooks: URL = `https://<your-domain>/api/webhooks/paystack`, subscribe to `charge.success`. Use test keys first.
4. UPS Developer app: OAuth + Tracking API access (sandbox first).
5. Admin role: after deploy, sign in as current admin in `admin.html` → Customers tab → Make admin for `daboffoods@gmail.com` (this uses the new Vercel endpoint; see `ADMIN-SETUP-VERCEL.md`).

## Tests performed
- `node --check` syntax OK for every new/modified server file and the three frontend files.
- Grep sweeps: no `httpsCallable` / `getFunctions` / `firebase-functions.js` remains in live frontend code (only in `backup-*` and `functions/` reference code).
- Security review: every protected endpoint verifies the ID token server-side; admin endpoints re-check `users/{uid}.role=admin`; ownership is enforced on payments/shipments; webhook never writes without a valid HMAC + fresh Paystack verification; no credentials in code.

## Features awaiting external credentials (cannot be tested from here)
- Live Paystack initialize/verify/webhook — needs `PAYSTACK_SECRET_KEY` + a real order with `finalPrice`.
- Live UPS refresh — needs `UPS_CLIENT_ID` / `UPS_CLIENT_SECRET` + a UPS shipment.
- **Out of scope on Vercel**: email/SMS order alerts (`onOrderCreated` / `onOrderUpdated` / `resendAlert` in Cloud Functions) still require Cloud Functions + billing + Gmail/Termii secrets. The admin "Resend" button now shows an info notice instead of failing. Alert history itself is still recorded in Firestore by existing code only if Cloud Functions is deployed.
- The old `functions/` directory is kept as reference but is NOT used by the website anymore. It is safe to delete once you're sure the Vercel backend works.
