# HS Small Finance (web app)

Customer registration, loan applications, Accounts and Admin verification, approval, disbursement,
repayment collection, overdue tracking, reports. Works on phones (for field employees) and desktops.

Zero dependencies: needs only **Node.js 22.5 or newer**. No `npm install`.

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

## Free demo deployment (Render)

The repository includes `render.yaml` for a free Render web service. In Render, choose **New > Blueprint**
and connect this GitHub repository. The service runs in demo mode, so OTP codes are displayed on screen.
Before first-time setup, copy the generated `HS_SETUP_TOKEN` from the service's environment settings into
the setup form. The token prevents a random visitor from claiming the initial Admin account.

This is only a disposable preview: Render's free web service has an ephemeral filesystem, may sleep when
idle, and can lose its SQLite database and uploaded files on restart, spin-down, or redeploy. Do not enter
real customer, identity, banking, or loan data. Real use needs paid durable storage, operational backups,
live SMS, and a separate production security review.

To let phones on the same Wi-Fi use it: `HOST=0.0.0.0 npm run demo`, then open `http://<computer-ip>:3000`.
Over a network use HTTPS (put it behind a reverse proxy) and set `HS_SECURE_COOKIE=1`.

## Where data is stored

Everything is in the `data/` folder (SQLite database, uploaded files, encryption key). **Back up that whole
folder.** Losing `data/.enckey` makes the encrypted ID numbers unreadable. Settings: `PORT`, `HOST`,
`HS_DATA_DIR`, `HS_ENC_KEY` (optional; overrides the key file), `DEMO_MODE`, `SMS_WEBHOOK_URL`,
`SMS_WEBHOOK_TOKEN`, `HS_SECURE_COOKIE`.

This is a single-computer setup for testing. When testing is finished the database layer (`server/db.js`
and the SQL in the route files) is the part to move to a hosted database.

## Tests

`npm test` runs 17 automated tests: business rules (interest, allocation, penalties, state machine,
eligibility) and a full API walkthrough (application to disbursement to collection, permissions, reversal, reports).

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
