# Firebase payments and shipment tracking deployment

This project continues to use Firebase Authentication, Cloud Firestore and the existing second-generation Cloud Functions project in `functions/`. No other database or backend server is added.

## Existing data model reused

- `users/{uid}`: existing profiles and `role` / `disabled` authorization fields.
- `orders/{orderId}`: existing order and current delivery workflow. `paymentStatus` and order `status` remain separate. Existing confirmed `finalPrice` is the authoritative Paystack charge amount.
- `riderLocations/{orderId}`: existing private live-rider source, exposed to the public tracker only as minimal coordinates through a rate-limited callable.
- Existing `alerts`, `settings`, `messages`, `applications`, `pricing`, and `riders` remain in use.

New records:

- `payments/{reference}`: Paystack attempts and verified COD collections, linked by `orderId` and `customerUid`.
- `shipments/{shipmentId}`: carrier-independent shipment records linked to `orderId` and `customerId`.
- `trackingEvents/{eventId}`: deduplicated carrier or admin events linked to the shipment/order/customer.
- `paymentWebhookEvents/{eventId}`: server-only webhook idempotency records.
- `trackingLookupLimits/{ipHash}`: server-only, short-lived rate-limit counters (no raw IP stored).

An order can have more than one shipment when operations require it. `trackingEvents` are queried by `shipmentId`; this uses Firestore's automatic single-field index. The index configuration enables a TTL policy for `trackingLookupLimits.expiresAt`; deploy it and confirm TTL is enabled in the Firestore console.

## Functions added

Paystack:

- `initializePaystackPayment` — requires Firebase Authentication, checks order ownership, uses the server's `finalPrice`, writes a pending payment, and requests a Paystack hosted checkout URL.
- `verifyPaystackPayment` — verifies with Paystack and checks reference, success status, exact amount, NGN currency, customer email/metadata, order/customer ownership, and current order amount before a transaction marks payment successful.
- `paystackWebhook` — validates Paystack's raw-body HMAC-SHA512 signature using a timing-safe compare, then independently verifies the transaction with Paystack. Settlement is idempotent.
- `recordCodCollection` — admin-only operation that marks a COD payment as collected; checkout and shipment status do not set it automatically.

Shipping:

- `getUpsAccessToken` — admin-only OAuth connectivity check; returns readiness only, never the token.
- `trackUpsShipment` — accepts only a Firestore shipment whose carrier is UPS, fetches official UPS tracking data server-side, normalizes available events, and stores deduplicated events.
- `lookupShipment` — IP-rate-limited callable returning a sanitized public tracking view, including only a minimal live location when available.
- `listMyShipments` — authenticated customer callable returning sanitized carrier shipment history for the signed-in customer.
- `createShipment`, `updateShipment`, `addTrackingEvent` — admin-authorized shipment operations; status changes and their tracking events are stored together.
- `adminListPayments`, `adminListShipments` — admin-only list callables for payment and shipment management.

Existing alert functions remain exported from `functions/index.js`.

## Frontend integration

- Customer dashboard (`account.html`): Pay Now for confirmed unpaid non-COD orders, per-customer payment history, backend verification after Paystack returns, and existing order history/reorder behavior.
- Admin dashboard (`admin.html`, `admin.js`): read-only payment status, payment search/filter, COD collection action, shipment create/edit, carrier/status filters, manual tracking events, and UPS refresh.
- Tracking page (`track.html`, `track.js`): uses `lookupShipment` instead of publicly reading raw order documents; displays safe carrier fields, estimated delivery only when available, event timeline, and a signed-in UPS refresh option.
- Booking page (`book.html`): preserves the existing request flow and adds COD selection; COD remains unpaid until recorded as collected.

## Configure credentials and environment

Use Firebase Functions Secrets for credentials. Do not put secret keys in source files, `.env` files, Firestore, or chat. Firebase CLI prompts for the secret values:

1. Install/update Firebase CLI and authenticate:
   - `npm install -g firebase-tools`
   - `firebase login`
2. Select the existing project:
   - `firebase use fl-logistics-ce201`
3. Set secrets one at a time (the CLI prompts securely):
   - `firebase functions:secrets:set PAYSTACK_SECRET_KEY`
   - `firebase functions:secrets:set UPS_CLIENT_ID`
   - `firebase functions:secrets:set UPS_CLIENT_SECRET`
4. Copy `functions/.env.example` to `functions/.env.fl-logistics-ce201` and set:
   - `SITE_URL` to the deployed HTTPS website origin (no trailing slash).
   - `UPS_ENVIRONMENT=sandbox` initially; change to `production` only after UPS sandbox testing and approval.
   These are non-secret values. Keep `.env.fl-logistics-ce201` out of version control; `.gitignore` already excludes it.
5. In `app.js`, replace `CONFIG.paystackPublicKey` with the Paystack **public** key for the same environment. It must start with `pk_test_` for sandbox or `pk_live_` for production. The Paystack secret key must never be copied there.
6. Configure a webhook in the Paystack dashboard at:
   - `https://us-central1-fl-logistics-ce201.cloudfunctions.net/paystackWebhook`
   Subscribe to `charge.success`. The handler verifies every event with Paystack before writing payment state.
7. In Firebase Console, confirm Cloud Functions, Secret Manager, Cloud Build, Artifact Registry, Firestore and Hosting APIs are enabled. Functions deployment requires a billing-enabled Firebase plan (Blaze) and permissions to create/use secrets and deploy functions.
8. Create/confirm an UPS Developer application with OAuth and Tracking API access for the selected sandbox/production environment.

Never test real charges with live keys. Use Paystack test credentials and UPS sandbox credentials first.

## Deployment order

Deploy Functions before tightening public tracking rules, so the callable is ready when the raw public Firestore reads are removed:

1. From the project root, install Functions dependencies: `npm --prefix functions install`.
2. Deploy Functions: `firebase deploy --only functions`.
3. Deploy Firestore rules and indexes/TTL configuration: `firebase deploy --only firestore:rules,firestore:indexes`.
4. Deploy the site: `firebase deploy --only hosting`.

The newly added `firebase.json` uses the existing static HTML site as Hosting content and the existing `functions/` folder as the Functions source. Verify the Hosting public directory/custom domain matches your actual deployment before deploying; if the site is hosted elsewhere, keep the current hosting arrangement and deploy only Functions/Firestore with the corresponding Firebase config.

## Security and operations notes

- The app currently determines admin authorization from `users/{uid}.role == "admin"` and `disabled != true`; every new callable re-checks this profile server-side. Do not let users write their own role. Firestore rules continue to protect role changes. Custom claims can be introduced later, but are not required for this existing authorization model.
- Admin UI payment status is read-only. Firestore client writes to `payments`, `shipments`, and `trackingEvents` are denied. Cloud Functions use the Admin SDK and perform explicit authentication/role/ownership checks.
- Customer access to payment documents is restricted by `customerUid`. Raw shipment/event documents are admin-only; customer dashboard shipment history and public tracking are returned by sanitized callables. Public tracking is IP-rate-limited and does not include customer contact details, payment status, or internal admin notes.
- Payment status changes to Paid only after Paystack verification or an admin recording actual COD collection. Shipment status is separate and never changes just because payment succeeded.
- Pay Now appears only after an administrator sets a confirmed `finalPrice`. Orders that have only a quotation request cannot be charged.
- Guest orders cannot be charged online until an administrator links them to an existing customer profile in Order Details; the link is validated by an admin callable. The customer then signs in to their dashboard to pay.
- Existing guest orders have `customerUid: null`; these can still use the existing order reference in the sanitized tracking lookup, but online payment requires an authenticated customer-owned order.

## Validation performed and not performed

Editor diagnostics were run on the touched website/Functions code during implementation. The Paystack and UPS APIs have **not** been exercised with merchant/developer credentials in this workspace. Before production launch, test the cases in the project request in Paystack test mode and UPS sandbox, deploy rules to the Firestore emulator or a non-production project, verify the webhook delivery/signature, and review the final live domain and Hosting configuration. Do not describe a payment as paid or UPS data as live until those external tests pass.
