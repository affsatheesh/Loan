// Postgres schema for Netlify Database. Mirrors the original SQLite tables one-to-one so the SQL in
// server/*.js keeps working. Timestamps are epoch milliseconds and money is in paise, both stored as bigint.
import { pgTable, serial, text, integer, bigint, doublePrecision, unique, index } from "drizzle-orm/pg-core";

const big = (name: string) => bigint(name, { mode: "number" });

export const users = pgTable("users", {
  id: serial().primaryKey(),
  code: text().unique(),
  username: text().notNull().unique(),
  name: text().notNull(),
  role: text().notNull(),
  mobile: text(),
  email: text(),
  status: text().notNull().default("ACTIVE"),
  pwHash: text("pw_hash").notNull(),
  pwSalt: text("pw_salt").notNull(),
  mustChange: integer("must_change").notNull().default(0),
  customerId: integer("customer_id"),
  failedLogins: integer("failed_logins").notNull().default(0),
  lockedUntil: big("locked_until"),
  createdAt: big("created_at").notNull(),
});

export const sessions = pgTable("sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: integer("user_id").notNull(),
  expiresAt: big("expires_at").notNull(),
}, (t) => [index("ix_sessions_user").on(t.userId)]);

export const products = pgTable("products", {
  id: serial().primaryKey(),
  name: text().notNull(),
  description: text(),
  minAmount: big("min_amount").notNull(),
  maxAmount: big("max_amount").notNull(),
  rateBps: integer("rate_bps").notNull(),
  ratePeriod: text("rate_period"),
  method: text(),
  term: integer().notNull(),
  frequency: text().notNull(),
  feeBps: integer("fee_bps").notNull(),
  penaltyPolicyId: integer("penalty_policy_id"),
  status: text().notNull().default("INACTIVE"),
  effectiveFrom: text("effective_from"),
  createdAt: big("created_at").notNull(),
});

export const penaltyPolicies = pgTable("penalty_policies", {
  id: serial().primaryKey(),
  name: text().notNull(),
  enabled: integer().notNull().default(0),
  graceDays: integer("grace_days").notNull().default(0),
  type: text().notNull().default("FIXED"),
  value: big("value").notNull().default(0),
  capPaise: big("cap_paise"),
  effectiveFrom: text("effective_from"),
  notes: text(),
  createdAt: big("created_at").notNull(),
});

export const eligibilityRules = pgTable("eligibility_rules", {
  id: serial().primaryKey(),
  version: integer().notNull(),
  minAge: integer("min_age").notNull(),
  maxAge: integer("max_age").notNull(),
  minIncome: big("min_income").notNull(),
  occupations: text().notNull().default(""),
  maxActiveLoans: integer("max_active_loans").notNull(),
  active: integer().notNull().default(0),
  createdBy: integer("created_by"),
  createdAt: big("created_at").notNull(),
});

export const customers = pgTable("customers", {
  id: serial().primaryKey(),
  ref: text().unique(),
  name: text().notNull(),
  dob: text().notNull(),
  mobile: text().notNull(),
  address: text().notNull(),
  pan: text(),
  voter: text(),
  aadhaar: text(),
  occupation: text().notNull(),
  adults: integer(),
  children: integer(),
  income: big("income").notNull(),
  assignedTo: integer("assigned_to"),
  mobileVerifiedAt: big("mobile_verified_at"),
  otpRef: text("otp_ref"),
  createdBy: integer("created_by"),
  createdAt: big("created_at").notNull(),
}, (t) => [index("ix_customers_mobile").on(t.mobile)]);

export const applications = pgTable("applications", {
  id: serial().primaryKey(),
  ref: text().unique(),
  customerId: integer("customer_id"),
  productId: integer("product_id"),
  employeeId: integer("employee_id").notNull(),
  status: text().notNull(),
  amount: big("amount"),
  term: integer(),
  frequency: text(),
  bankHolder: text("bank_holder"),
  bankName: text("bank_name"),
  bankAccount: text("bank_account"),
  bankIfsc: text("bank_ifsc"),
  eligibility: text(),
  ruleVersion: integer("rule_version"),
  draft: text(),
  returnTo: text("return_to"),
  docReviewDone: integer("doc_review_done").notNull().default(0),
  submittedAt: big("submitted_at"),
  createdAt: big("created_at").notNull(),
  updatedAt: big("updated_at").notNull(),
}, (t) => [index("ix_app_status").on(t.status), index("ix_app_emp").on(t.employeeId)]);

export const otps = pgTable("otps", {
  id: serial().primaryKey(),
  applicationId: integer("application_id").notNull(),
  mobile: text().notNull(),
  codeHash: text("code_hash").notNull(),
  ref: text().notNull(),
  expiresAt: big("expires_at").notNull(),
  attempts: integer().notNull().default(0),
  verifiedAt: big("verified_at"),
  createdAt: big("created_at").notNull(),
  demo: integer().notNull().default(0),
}, (t) => [index("ix_otps_app").on(t.applicationId)]);

export const documents = pgTable("documents", {
  id: serial().primaryKey(),
  applicationId: integer("application_id"),
  customerId: integer("customer_id"),
  type: text().notNull(),
  fileId: text("file_id").notNull(),
  originalName: text("original_name"),
  mime: text(),
  size: integer(),
  uploadedBy: integer("uploaded_by"),
  uploadedAt: big("uploaded_at").notNull(),
  status: text().notNull().default("PENDING_REVIEW"),
  comment: text(),
  reviewedBy: integer("reviewed_by"),
  reviewedAt: big("reviewed_at"),
  version: integer().notNull().default(1),
  uploadKey: text("upload_key").unique(),
  requestedNote: text("requested_note"),
}, (t) => [index("ix_docs_app").on(t.applicationId)]);

export const timeline = pgTable("timeline", {
  id: serial().primaryKey(),
  applicationId: integer("application_id").notNull(),
  fromStatus: text("from_status"),
  toStatus: text("to_status"),
  userId: integer("user_id"),
  at: big("at").notNull(),
  comment: text(),
  ref: text(),
}, (t) => [index("ix_timeline_app").on(t.applicationId)]);

export const audit = pgTable("audit", {
  id: serial().primaryKey(),
  userId: integer("user_id"),
  action: text().notNull(),
  entity: text(),
  entityId: text("entity_id"),
  detail: text(),
  at: big("at").notNull(),
});

export const verifications = pgTable("verifications", {
  id: serial().primaryKey(),
  applicationId: integer("application_id").notNull(),
  kind: text().notNull(),
  verifierId: integer("verifier_id"),
  outcome: text().notNull(),
  comment: text(),
  checklist: text(),
  lat: doublePrecision(),
  lng: doublePrecision(),
  accuracy: doublePrecision(),
  locationNote: text("location_note"),
  photoDocId: integer("photo_doc_id"),
  at: big("at").notNull(),
}, (t) => [index("ix_verif_app").on(t.applicationId)]);

export const loans = pgTable("loans", {
  id: serial().primaryKey(),
  ref: text().unique(),
  applicationId: integer("application_id").unique(),
  customerId: integer("customer_id").notNull(),
  productId: integer("product_id"),
  employeeId: integer("employee_id"),
  principal: big("principal").notNull(),
  rateBps: integer("rate_bps").notNull(),
  ratePeriod: text("rate_period").notNull(),
  method: text().notNull(),
  term: integer().notNull(),
  frequency: text().notNull(),
  feeBps: integer("fee_bps").notNull(),
  feeAmount: big("fee_amount").notNull(),
  penalty: text().notNull(),
  status: text().notNull(),
  approvedBy: integer("approved_by"),
  approvedAt: big("approved_at"),
  disbursedAt: big("disbursed_at"),
  disbursedBy: integer("disbursed_by"),
  disbursedMethod: text("disbursed_method"),
  disbursedRef: text("disbursed_ref"),
  closedAt: big("closed_at"),
  closedBy: text("closed_by"),
  firstDueDate: text("first_due_date").notNull(),
  followupStatus: text("followup_status").notNull().default("NONE"),
  followupNote: text("followup_note"),
});

export const instalments = pgTable("instalments", {
  id: serial().primaryKey(),
  loanId: integer("loan_id").notNull(),
  number: integer().notNull(),
  dueDate: text("due_date").notNull(),
  principal: big("principal").notNull(),
  interest: big("interest").notNull(),
  fees: big("fees").notNull().default(0),
  penalty: big("penalty").notNull().default(0),
  principalPaid: big("principal_paid").notNull().default(0),
  interestPaid: big("interest_paid").notNull().default(0),
  feesPaid: big("fees_paid").notNull().default(0),
  penaltyPaid: big("penalty_paid").notNull().default(0),
  penaltyWaived: big("penalty_waived").notNull().default(0),
  waiverReason: text("waiver_reason"),
}, (t) => [unique("instalments_loan_number").on(t.loanId, t.number), index("ix_inst_loan").on(t.loanId)]);

export const payments = pgTable("payments", {
  id: serial().primaryKey(),
  receiptNo: text("receipt_no").unique(),
  loanId: integer("loan_id").notNull(),
  amount: big("amount").notNull(),
  method: text().notNull(),
  reference: text(),
  remarks: text(),
  collectedBy: integer("collected_by"),
  collectedAt: big("collected_at").notNull(),
  deviceTime: text("device_time"),
  status: text().notNull().default("POSTED"),
  reversesId: integer("reverses_id"),
  reason: text(),
  idemKey: text("idem_key").unique(),
}, (t) => [index("ix_pay_loan").on(t.loanId)]);

export const paymentAllocations = pgTable("payment_allocations", {
  id: serial().primaryKey(),
  paymentId: integer("payment_id").notNull(),
  instalmentId: integer("instalment_id").notNull(),
  principal: big("principal").notNull(),
  interest: big("interest").notNull(),
  fees: big("fees").notNull(),
  penalty: big("penalty").notNull(),
}, (t) => [index("ix_alloc_payment").on(t.paymentId)]);

export const notifications = pgTable("notifications", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull(),
  type: text().notNull(),
  title: text().notNull(),
  body: text(),
  entity: text(),
  entityId: integer("entity_id"),
  read: integer().notNull().default(0),
  createdAt: big("created_at").notNull(),
}, (t) => [index("ix_notif_user").on(t.userId, t.read)]);

export const expenses = pgTable("expenses", {
  id: serial().primaryKey(),
  date: text().notNull(),
  category: text().notNull(),
  amount: big("amount").notNull(),
  note: text(),
  createdBy: integer("created_by"),
  createdAt: big("created_at").notNull(),
});

export const counters = pgTable("counters", {
  name: text().primaryKey(),
  value: integer().notNull(),
});
