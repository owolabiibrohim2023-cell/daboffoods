# Paystack Payment Integration - Testing & Deployment Guide

## Overview
This document describes the complete payment flow and how to test it locally and in production.

## Payment Flow
1. Customer creates shipment request on book.html
2. Customer selects payment option: Quotation required, Online payment (Paystack), or Cash on delivery
3. Admin reviews order in admin.html and sets finalPrice (confirmed amount)
4. Customer goes to account.html dashboard My Orders tab
5. Pay Now button appears for orders with:
   - finalPrice set (not null)
   - paymentStatus not Paid
   - paymentOption not Cash on delivery
6. Customer clicks Pay Now -> calls /api/payments/initialize
7. Backend creates Paystack transaction -> returns authorizationUrl
8. Customer redirected to Paystack checkout
9. After payment, Paystack redirects to /account.html?payment_reference=xxx
10. Frontend calls /api/payments/verify to confirm payment
11. Backend verifies with Paystack, updates order paymentStatus to Paid
12. Shipment tracking activated only after verified payment

## Required Environment Variables

### Local Development (.env.local)
FIREBASE_SERVICE_ACCOUNT_KEY={"type":"service_account","project_id":"fl-logistics-ce201",...}
PAYSTACK_SECRET_KEY=sk_test_xxxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxxx
SITE_URL=http://localhost:3000
UPS_CLIENT_ID=xxx
UPS_CLIENT_SECRET=xxx
UPS_ENVIRONMENT=sandbox

### Production (Vercel Dashboard Settings Environment Variables)
Set for Production and Preview environments:
FIREBASE_SERVICE_ACCOUNT_KEY - Full service account JSON single line
PAYSTACK_SECRET_KEY - Paystack secret key sk_live_...
PAYSTACK_PUBLIC_KEY - Paystack public key pk_live_...
SITE_URL - Production HTTPS domain e.g. https://daboffoods-murex.vercel.app/
UPS_CLIENT_ID - UPS OAuth client ID
UPS_CLIENT_SECRET - UPS OAuth client secret
UPS_ENVIRONMENT - sandbox or production

## Frontend Configuration
Update CONFIG.paystackPublicKey in app.js:
paystackPublicKey: "pk_test_your_actual_test_key"

## Local Testing Setup

### 1. Install Dependencies
npm install
cd functions && npm install

### 2. Start Local Development Server
npx vercel dev (recommended - runs api/ functions locally)
npx serve . (frontend only, no API)

### 3. Configure Firebase Emulator (Optional)
firebase emulators:start --only firestore,auth

### 4. Test Paystack in Test Mode
Use Paystack test keys (sk_test_..., pk_test_...)
Test card numbers: https://paystack.com/docs/test-cards
Success: 4084 0840 8408 4081
Decline: 4000 0000 0000 0002
CVV: any 3 digits
Expiry: any future date
OTP: 123456

## End-to-End Test Checklist

### Phase 1: Order Creation
Go to book.html
Fill in sender/receiver details
Select Online payment (Paystack) as payment option
Submit order
Verify order appears in dashboard with Quotation required status

### Phase 2: Admin Price Confirmation
Sign in as admin -> admin.html
Find the order in All Orders tab
Click edit -> set Final agreed price (e.g., 5000)
Save changes
Verify order now shows confirmed price

### Phase 3: Pay Now Button Visibility
Sign in as customer -> account.html
Go to My Orders tab
Verify Pay now button appears for the order
Verify button does NOT appear for:
- Orders without finalPrice
- COD orders
- Already paid orders

### Phase 4: Payment Initialization
Click Pay now button
Button shows Connecting to Paystack... spinner
Browser redirects to checkout.paystack.com
Paystack checkout page loads with correct amount

### Phase 5: Payment Completion
Use test card: 4084 0840 8408 4081
Complete payment with OTP 123456
Paystack redirects back to /account.html?payment_reference=DAB-xxx
Dashboard shows Verifying your Paystack payment securely...
Payment verification succeeds
Order shows Payment: Paid badge
Payment history shows successful transaction

### Phase 6: Failed/Cancelled Payment
Test with declined card: 4000 0000 0000 0002
Verify payment status shows failed
Verify order paymentStatus remains Pending
Verify shipment NOT activated

### Phase 7: COD Order Flow
Create order with Cash on delivery
Admin sets finalPrice
Verify NO Pay Now button appears
Admin records COD collection in admin panel
Verify paymentStatus changes to Paid

## API Endpoints (Vercel Serverless Functions)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/payments/initialize | POST | Initialize Paystack transaction |
| /api/payments/verify | POST | Verify payment after redirect |
| /api/payments/cod-collect | POST | Admin records COD collection |
| /api/webhooks/paystack | POST | Paystack webhook charge.success |

## Security Notes
Paystack secret key ONLY in backend (Vercel env vars)
Paystack public key in frontend (app.js CONFIG)
All payment initialization/verification server-side
Order ownership verified on every API call
Idempotent payment settlement (prevents double-charging)
Webhook signature verified with HMAC-SHA512
Amount, currency, email validated before settlement

## Troubleshooting

### Pay Now button not visible
Check order has finalPrice set (admin must confirm price)
Check paymentOption is not Cash on delivery
Check paymentStatus is not Paid
Check user owns the order (customerUid matches)

### Payment initialization fails
Check Vercel function logs: vercel logs
Verify PAYSTACK_SECRET_KEY is set correctly
Verify SITE_URL matches deployed domain
Check order has valid finalPrice > 0

### Payment verification fails
Check payment_reference URL parameter
Verify webhook is configured in Paystack
Check function logs for verification errors

### Webhook not received
Verify webhook URL in Paystack dashboard
Check PAYSTACK_SECRET_KEY matches Paystack account
Check Vercel function logs for HMAC verification errors

## Deployment Checklist
All environment variables set in Vercel (Production + Preview)
app.js updated with production Paystack public key
Paystack webhook URL configured in Paystack dashboard
UPS credentials configured (if using shipment tracking)
Firebase service account has required roles (Auth Admin, Datastore User)
Firestore rules deployed: firebase deploy --only firestore:rules
Test complete flow in production with Paystack test mode
Switch to Paystack live keys for production launch
Update SITE_URL to production domain
Update UPS_ENVIRONMENT to production
Monitor Vercel function logs for errors

## File Structure Summary
api/payments/initialize.js - POST /api/payments/initialize
api/payments/verify.js - POST /api/payments/verify
api/payments/cod-collect.js - POST /api/payments/cod-collect
api/webhooks/paystack.js - POST /api/webhooks/paystack
api/_lib/paystack.js - Paystack API helpers
api/_lib/auth.js - Auth verification
api/_lib/admin.js - Firebase Admin SDK
book.html - Booking form (updated with Online payment option)
account.html - Customer dashboard (Pay Now button logic)
admin.html - Admin panel (price confirmation)
app.js - Shared config (paystackPublicKey)
lib/client.js - API call helper
.env.example - Environment template
.env.local - Local development (gitignored)
PAYMENT-TESTING-GUIDE.md - This file

## Support
For issues with Paystack integration: Check Paystack docs + Vercel function logs
For Firebase/Firestore: Check Firebase Console Functions logs
For Vercel deployment: Check Vercel Dashboard Functions Logs