# DABOFFOODS — Website Cleanup & Payment/Tracking Report

Date: 2026-11-05. Backup of pre-cleanup frontend: `backup-2026-11-05/` (inside the project — delete it or add it to `firebase.json` hosting ignore before deploying, otherwise it will be published).

## 1. WhatsApp removed (kept only as optional support)
Removed: floating WhatsApp button, all ordering/enquiry WhatsApp buttons and redirects, WhatsApp booking message flow, WhatsApp notification preference, "continue on WhatsApp" fallbacks.
- `app.js`: removed floating `wa-float` button; footer now says "WhatsApp support (optional)"; added `SUPPORT_WHATSAPP` flag (helper kept for Contact page/admin only).
- `book.html`: summary card no longer has "Continue on WhatsApp". Success screen shows tracking number, Paystack guidance, copy/track buttons. Error copy no longer routes to WhatsApp.
- `index.html`: How It Works step 2 is now "Pay online with Paystack". All homepage CTAs route to `book.html` / `track.html`.
- `services.js` / `services.html`: "Enquire on WhatsApp" → "Book this service" (`book.html?service=…`).
- `products.js` / `food-products.html`: "Order / Enquire" (WhatsApp) → "Order on website" (`book.html?service=Food%20Export%20Services&product=…`); book.html pre-fills the product in the goods field.
- `payment.html`: "Confirm directly" (WhatsApp) → "Review your order" (dashboard/tracking).
- `track.html` / `track.js`: removed WhatsApp help/rider/not-found buttons. Not-found/help link to Contact page / phone. Tracking never needed WhatsApp.
- `contact.html`: removed "Also send on WhatsApp" button + prefilled message; kept ONE optional "WhatsApp (support)" card. Failure copy says try again / call.
- `faq.html`, `careers.html`, `pricing.html`, `account.html`: WhatsApp CTAs removed/relabelled; accounts keep Email/SMS preferences only.
- KEPT (operational): admin "Message customer", admin inbox "Reply WhatsApp", rider "WhatsApp customer/receiver", contact page support card, footer support link.

## 2. Direct Paystack payments (server-verified)
Flow: Book → admin confirms `finalPrice` → dashboard **Pay Now** → `initializePaystackPayment` (ownership + confirmed amount + our own callback URL) → Paystack checkout → `verifyPaystackPayment` re-verifies with Paystack API (amount, currency, email, ownership) → `settleVerifiedPayment` marks `payments/{ref}` success and `orders/{id}.paymentStatus=Paid` idempotently; webhook `paystackWebhook` (HMAC-SHA512, idempotent) is the backstop. No fake confirmations.
States shown: Pending / Paid / COD badges, payment history, verify banner (success / pending / failed), admin payment tab.
Hardened this pass (`functions/payments.js`):
- Paystack callback URL validated server-side against our own `SITE_URL` host + `/account.html` path.
- `verifyPaystackPayment` validates reference format before any Firestore read.
- Added admin-only `adminUpdateOrderStatus` (audited `statusHistory`); never marks Paid.
`book.html` success screen: signed-in users → "Go to dashboard to pay"; guests → "Sign in to pay online" (backend requires an account; admins can link guest orders via `linkOrderToCustomer`).

## 3. Shipment tracking
Every order gets tracking number `DAB-XXXXX`. `track.html` + `lookupShipment` (rate-limited, sanitized) shows carrier, status, origin/destination, estimated delivery, latest update, event timeline, live rider map, share button — no WhatsApp needed.
UPS: `trackUpsShipment` fetches official UPS API server-side, normalizes + deduplicates events; signed-in users can refresh.
Other carriers: admin `createShipment` / `updateShipment` / `addTrackingEvent` (manual events); `publicShipment` now also exposes `latestUpdate`.

## 4. Admin management
Orders (status + confirmed price + COD collect + rider assign + waybill), Customers (enable/disable + Make admin/Remove admin via Vercel endpoint), Riders (create/edit/deactivate/delete), Payments (search/filter status), Shipments (carrier/tracking number, edit status, manual events, UPS refresh), Alerts, Inbox, Applications, Pricing, Templates. Trusted writes go through server-side functions (Admin SDK / callable re-checks `role=admin`).

## 5. Still requires your configuration
1. **Firebase billing (Blaze) ON** — required for Cloud Functions (payments, shipping, alerts). The Vercel endpoint only covers role changes; it does NOT replace this.
2. **Function secrets** (`firebase functions:secrets:set`): `PAYSTACK_SECRET_KEY`, `UPS_CLIENT_ID`, `UPS_CLIENT_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `TERMII_API_KEY`, `TERMII_SENDER_ID`.
3. **`.env` (functions)**: `SITE_URL=https://<your live domain>`, `UPS_ENVIRONMENT=sandbox` for testing.
4. **Deploy**: `firebase deploy --only functions,firestore:rules,firestore:indexes,hosting`.
5. **Paystack dashboard**: webhook URL = deployed `paystackWebhook` function URL, subscribe to `charge.success`. Use test keys first.
6. **UPS developer app**: OAuth + Tracking API access (sandbox first).
7. **Admin role**: complete Vercel env-var setup in `ADMIN-SETUP-VERCEL.md` so `daboffoods@gmail.com` can be promoted (UID `aR46fqrmFifk6WfcKyOChtLkDqq1`).
8. **Not tested here**: live Paystack/UPS calls need your credentials; verify in test/sandbox before launch.

## Validation
- `node --check` passed: `functions/payments.js`, `functions/shipping.js`, `api/promote-admin.js`, `scripts/promote-admin.js`, `products.js`, `services.js`.
- Grep sweeps: no live code references removed WhatsApp element IDs (they remain only in `backup-2026-11-05/`).
- No fake payment confirmations or fake tracking data added.
