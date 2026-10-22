CREATE TABLE "applications" (
	"id" serial PRIMARY KEY,
	"ref" text UNIQUE,
	"customer_id" integer,
	"product_id" integer,
	"employee_id" integer NOT NULL,
	"status" text NOT NULL,
	"amount" bigint,
	"term" integer,
	"frequency" text,
	"bank_holder" text,
	"bank_name" text,
	"bank_account" text,
	"bank_ifsc" text,
	"eligibility" text,
	"rule_version" integer,
	"draft" text,
	"return_to" text,
	"doc_review_done" integer DEFAULT 0 NOT NULL,
	"submitted_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit" (
	"id" serial PRIMARY KEY,
	"user_id" integer,
	"action" text NOT NULL,
	"entity" text,
	"entity_id" text,
	"detail" text,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "counters" (
	"name" text PRIMARY KEY,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY,
	"ref" text UNIQUE,
	"name" text NOT NULL,
	"dob" text NOT NULL,
	"mobile" text NOT NULL,
	"address" text NOT NULL,
	"pan" text,
	"voter" text,
	"aadhaar" text,
	"occupation" text NOT NULL,
	"adults" integer,
	"children" integer,
	"income" bigint NOT NULL,
	"assigned_to" integer,
	"mobile_verified_at" bigint,
	"otp_ref" text,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" serial PRIMARY KEY,
	"application_id" integer,
	"customer_id" integer,
	"type" text NOT NULL,
	"file_id" text NOT NULL,
	"original_name" text,
	"mime" text,
	"size" integer,
	"uploaded_by" integer,
	"uploaded_at" bigint NOT NULL,
	"status" text DEFAULT 'PENDING_REVIEW' NOT NULL,
	"comment" text,
	"reviewed_by" integer,
	"reviewed_at" bigint,
	"version" integer DEFAULT 1 NOT NULL,
	"upload_key" text UNIQUE,
	"requested_note" text
);
--> statement-breakpoint
CREATE TABLE "eligibility_rules" (
	"id" serial PRIMARY KEY,
	"version" integer NOT NULL,
	"min_age" integer NOT NULL,
	"max_age" integer NOT NULL,
	"min_income" bigint NOT NULL,
	"occupations" text DEFAULT '' NOT NULL,
	"max_active_loans" integer NOT NULL,
	"active" integer DEFAULT 0 NOT NULL,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" serial PRIMARY KEY,
	"date" text NOT NULL,
	"category" text NOT NULL,
	"amount" bigint NOT NULL,
	"note" text,
	"created_by" integer,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instalments" (
	"id" serial PRIMARY KEY,
	"loan_id" integer NOT NULL,
	"number" integer NOT NULL,
	"due_date" text NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	"fees" bigint DEFAULT 0 NOT NULL,
	"penalty" bigint DEFAULT 0 NOT NULL,
	"principal_paid" bigint DEFAULT 0 NOT NULL,
	"interest_paid" bigint DEFAULT 0 NOT NULL,
	"fees_paid" bigint DEFAULT 0 NOT NULL,
	"penalty_paid" bigint DEFAULT 0 NOT NULL,
	"penalty_waived" bigint DEFAULT 0 NOT NULL,
	"waiver_reason" text,
	CONSTRAINT "instalments_loan_number" UNIQUE("loan_id","number")
);
--> statement-breakpoint
CREATE TABLE "loans" (
	"id" serial PRIMARY KEY,
	"ref" text UNIQUE,
	"application_id" integer UNIQUE,
	"customer_id" integer NOT NULL,
	"product_id" integer,
	"employee_id" integer,
	"principal" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"rate_period" text NOT NULL,
	"method" text NOT NULL,
	"term" integer NOT NULL,
	"frequency" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"fee_amount" bigint NOT NULL,
	"penalty" text NOT NULL,
	"status" text NOT NULL,
	"approved_by" integer,
	"approved_at" bigint,
	"disbursed_at" bigint,
	"disbursed_by" integer,
	"disbursed_method" text,
	"disbursed_ref" text,
	"closed_at" bigint,
	"closed_by" text,
	"first_due_date" text NOT NULL,
	"followup_status" text DEFAULT 'NONE' NOT NULL,
	"followup_note" text
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"entity" text,
	"entity_id" integer,
	"read" integer DEFAULT 0 NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "otps" (
	"id" serial PRIMARY KEY,
	"application_id" integer NOT NULL,
	"mobile" text NOT NULL,
	"code_hash" text NOT NULL,
	"ref" text NOT NULL,
	"expires_at" bigint NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"verified_at" bigint,
	"created_at" bigint NOT NULL,
	"demo" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_allocations" (
	"id" serial PRIMARY KEY,
	"payment_id" integer NOT NULL,
	"instalment_id" integer NOT NULL,
	"principal" bigint NOT NULL,
	"interest" bigint NOT NULL,
	"fees" bigint NOT NULL,
	"penalty" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY,
	"receipt_no" text UNIQUE,
	"loan_id" integer NOT NULL,
	"amount" bigint NOT NULL,
	"method" text NOT NULL,
	"reference" text,
	"remarks" text,
	"collected_by" integer,
	"collected_at" bigint NOT NULL,
	"device_time" text,
	"status" text DEFAULT 'POSTED' NOT NULL,
	"reverses_id" integer,
	"reason" text,
	"idem_key" text UNIQUE
);
--> statement-breakpoint
CREATE TABLE "penalty_policies" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"type" text DEFAULT 'FIXED' NOT NULL,
	"value" bigint DEFAULT 0 NOT NULL,
	"cap_paise" bigint,
	"effective_from" text,
	"notes" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY,
	"name" text NOT NULL,
	"description" text,
	"min_amount" bigint NOT NULL,
	"max_amount" bigint NOT NULL,
	"rate_bps" integer NOT NULL,
	"rate_period" text,
	"method" text,
	"term" integer NOT NULL,
	"frequency" text NOT NULL,
	"fee_bps" integer NOT NULL,
	"penalty_policy_id" integer,
	"status" text DEFAULT 'INACTIVE' NOT NULL,
	"effective_from" text,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY,
	"user_id" integer NOT NULL,
	"expires_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline" (
	"id" serial PRIMARY KEY,
	"application_id" integer NOT NULL,
	"from_status" text,
	"to_status" text,
	"user_id" integer,
	"at" bigint NOT NULL,
	"comment" text,
	"ref" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" serial PRIMARY KEY,
	"code" text UNIQUE,
	"username" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"mobile" text,
	"email" text,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"pw_hash" text NOT NULL,
	"pw_salt" text NOT NULL,
	"must_change" integer DEFAULT 0 NOT NULL,
	"customer_id" integer,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" bigint,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" serial PRIMARY KEY,
	"application_id" integer NOT NULL,
	"kind" text NOT NULL,
	"verifier_id" integer,
	"outcome" text NOT NULL,
	"comment" text,
	"checklist" text,
	"lat" double precision,
	"lng" double precision,
	"accuracy" double precision,
	"location_note" text,
	"photo_doc_id" integer,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ix_app_status" ON "applications" ("status");--> statement-breakpoint
CREATE INDEX "ix_app_emp" ON "applications" ("employee_id");--> statement-breakpoint
CREATE INDEX "ix_customers_mobile" ON "customers" ("mobile");--> statement-breakpoint
CREATE INDEX "ix_docs_app" ON "documents" ("application_id");--> statement-breakpoint
CREATE INDEX "ix_inst_loan" ON "instalments" ("loan_id");--> statement-breakpoint
CREATE INDEX "ix_notif_user" ON "notifications" ("user_id","read");--> statement-breakpoint
CREATE INDEX "ix_otps_app" ON "otps" ("application_id");--> statement-breakpoint
CREATE INDEX "ix_alloc_payment" ON "payment_allocations" ("payment_id");--> statement-breakpoint
CREATE INDEX "ix_pay_loan" ON "payments" ("loan_id");--> statement-breakpoint
CREATE INDEX "ix_sessions_user" ON "sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "ix_timeline_app" ON "timeline" ("application_id");--> statement-breakpoint
CREATE INDEX "ix_verif_app" ON "verifications" ("application_id");