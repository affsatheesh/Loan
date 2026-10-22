# HS Small Finance (web app)

Customer registration, loan applications, Accounts and Admin verification, approval, disbursement,
repayment collection, overdue tracking, reports. Works on phones (for field employees) and desktops.

Requires **Node.js 22.5 or newer**. Install dependencies with `npm install`.

## Run it

```bash
cd hs-finance
npm run demo        # testing: OTP codes are shown on screen, clearly labelled DEMO MODE
# or
npm start           # real mode: OTP needs an SMS service (see below)
```

Open http://127.0.0.1:3000. On first start you create the Admin account yourself; there are no built-in
passwords. The Admin then creates Employee, Accounts and Customer logins (each gets a one-time
temporary password they must change at first login).

## Free test deployment (Render + Neon)

The service uses PostgreSQL. For a free test environment, create a Neon project and database, then copy its
**pooled** connection string (host includes `-pooler`) into the Render service environment variable `DATABASE_URL`.
Keep that URL private; never commit it or paste it into chat. On startup, the app applies its PostgreSQL schema
migration. The repository's `render.yaml` declares this variable as secret/unmanaged so Render prompts for it.

The service runs in demo mode, so OTP codes are displayed on screen. During first-time setup, enter the
`HS_SETUP_TOKEN` shown in Render's environment settings. Neon Free compute suspends after five minutes idle
and wakes on the next query; this is not a data reset. Its free tier has usage/storage limits and limited recovery
options. Documents are stored in Postgres too, so they count against the database quota. Back up test data
yourself. Do not use this free setup for real customer, identity, banking, or lending data.

To let phones on the same Wi-Fi use it: `HOST=0.0.0.0 npm run demo`, then open `http://<computer-ip>:3000`.
Over a network use HTTPS (put it behind a reverse proxy) and set `HS_SECURE_COOKIE=1`.

## Database and secrets

`DATABASE_URL` selects a hosted PostgreSQL database; when omitted, the Netlify Database adapter is used.
Uploaded documents are stored in the same PostgreSQL database when `DATABASE_URL` is configured. Keep
`HS_ENC_KEY` stable: losing or changing it makes encrypted identity fields unreadable. Other settings:
`PORT`, `HOST`, `HS_ENC_KEY`, `DEMO_MODE`, `HS_SETUP_TOKEN`, `SMS_WEBHOOK_URL`, `SMS_WEBHOOK_TOKEN`,
`HS_SECURE_COOKIE`. Back up the database and the encryption key together.

## Tests

`npm test` runs automated tests using PGlite (PostgreSQL-compatible): business rules and API walkthroughs,
including setup, permissions, disbursement, collections, reversals, and reports.

## What is implemented

* **Roles and security:** Employee, Accounts, Admin, Customer. Every action is authorised on the server.
  Passwords hashed (scrypt), lockout after repeated failures, sessions end on logout or deactivation,
  PAN / voter ID / Aadhaar / bank account encrypted at rest and masked for Employees and Customers,
  files stored under random IDs and served only to permitted users, full audit log.
* **Employee:** dashboard (all figures from the database), 6-step Add Customer wizard with drafts, camera or file
  upload with preview/retry, OTP step, loan estimate and preliminary eligibility, customer list with
  All / Pending / Active / Closed / Overdue (counts and lists use one function), collect payment, payment
  history, receipts, overdue list, notifications, profile.
* **Accounts:** queue, call verification record, approve / reject / request information.
* **Admin:** document review (verify, reject, request replacement, zoom), physical verification (checklist, photo,
  location or a recorded reason), printable application package, signed-agreement review, final approval that
  locks the loan terms and schedule, disbursement, loan products, eligibility rules (versioned), penalty
  policies, users, expenses, dashboard, 18 reports with CSV export and print / save-as-PDF, audit log.
* **Customer:** sees only their own application status, loan, schedule, payments and notifications.
* **Money rules:** amounts in paise (no floating point); flat or reducing interest; per month or per year, never assumed;
  payments applied oldest instalment first (penalty, fees, interest, principal); duplicate-submission protection;
  reversal instead of deletion; penalty charged once per instalment and only if a policy is enabled.

## Assumptions to confirm

* 26% interest and 8% fee are only starting values. A product **cannot be activated** until you choose the rate period
  (monthly / yearly) and method (flat / reducing).
* The processing fee is treated as **deducted from the amount paid out** at disbursement.
* A loan closes automatically when every instalment, including any penalty, is settled; reversing the last payment reopens it.
* Voter ID is mandatory; Aadhaar is optional and, if entered, both sides must be uploaded.
* An employee can collect only on loans they handle; Admin can collect on any.

## Not implemented / not verified

* **Real SMS OTP:** needs your provider. Set `SMS_WEBHOOK_URL` to an endpoint that accepts `{mobile, message}` JSON and
  sends the SMS (a few lines on MSG91, Twilio, etc.). Without it, OTP is refused outside demo mode. **Not tested against a live SMS service.**
* Bank-account ownership verification (the app says plainly it is unverified), push notifications (notifications are in-app),
  offline queue, cash-deposit reconciliation, write-offs, document upload by customers, SMS due-date reminders, Tamil screens.
* PDFs are produced with the browser's Print > Save as PDF, not server-generated files.
* Tested with automated API tests and a scripted Chromium run on a phone-sized and a desktop window. Not tested on real phones,
  other browsers, or with many simultaneous users.
* Penalty and fee rules must match your signed contract and applicable lending regulations; this software does not give legal advice.
