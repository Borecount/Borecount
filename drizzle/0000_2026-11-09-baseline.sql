-- PostgreSQL function required by the generated UUID defaults.
CREATE FUNCTION public.uuid_v7() RETURNS uuid
    LANGUAGE sql
    AS $$
  WITH ts AS (
    SELECT lpad(to_hex(floor(extract(epoch from clock_timestamp()) * 1000)::bigint), 12, '0') AS v
  ),
  rb AS (
    SELECT md5(random()::text || clock_timestamp()::text || random()::text) AS v
  ),
  va AS (
    SELECT substr('89ab', floor(random() * 4)::int + 1, 1) AS v
  )
  SELECT (
    substr(ts.v, 1, 8) || '-' ||
    substr(ts.v, 9, 4) || '-' ||
    '7' || substr(rb.v, 1, 3) || '-' ||
    va.v || substr(rb.v, 4, 3) || '-' ||
    substr(rb.v, 7, 12)
  )::uuid
  FROM ts, rb, va;
$$;
--> statement-breakpoint
CREATE TYPE "public"."account_side" AS ENUM('DEBIT', 'CREDIT');
--> statement-breakpoint
CREATE TYPE "public"."balance_snapshot_event_type" AS ENUM('TX_APPLIED', 'HOLD_CREATED', 'HOLD_COMMITTED', 'HOLD_VOIDED', 'ADJUSTMENT');
--> statement-breakpoint
CREATE TYPE "public"."credit_grant_entry_kind" AS ENUM('ISSUANCE', 'REVERSAL', 'CONSUMPTION', 'COMPENSATION', 'EXPIRATION', 'REFUND');
--> statement-breakpoint
CREATE TYPE "public"."hold_state" AS ENUM('HELD', 'APPLIED', 'VOIDED');
--> statement-breakpoint
CREATE TYPE "public"."overdraft_policy" AS ENUM('ALLOW', 'DISALLOW');
--> statement-breakpoint
CREATE TYPE "public"."reconciliation_result_status" AS ENUM('matched', 'unmatched_external', 'unmatched_internal', 'mismatched', 'conflict');
--> statement-breakpoint
CREATE TYPE "public"."reconciliation_run_status" AS ENUM('pending', 'running', 'completed', 'failed');
--> statement-breakpoint
CREATE TYPE "public"."transaction_relation_type" AS ENUM('REVERSAL', 'CORRECTION');
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"code" text,
	"name" text NOT NULL,
	"side" "account_side" NOT NULL,
	"overdraft_policy" "overdraft_policy" DEFAULT 'ALLOW' NOT NULL,
	"currency" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"balance_minor" bigint DEFAULT 0 NOT NULL,
	"reserved_delta_minor" bigint DEFAULT 0 NOT NULL,
	"grant_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "accounts_reserved_delta_side_chk" CHECK (("accounts"."side" = 'DEBIT' and "accounts"."reserved_delta_minor" <= 0) or ("accounts"."side" = 'CREDIT' and "accounts"."reserved_delta_minor" >= 0)),
	CONSTRAINT "accounts_grant_enabled_shape_chk" CHECK (not "accounts"."grant_enabled" or ("accounts"."side" = 'CREDIT' and "accounts"."overdraft_policy" = 'DISALLOW'))
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "api_keys_role_chk" CHECK ("api_keys"."role" in ('ADMIN', 'SERVICE'))
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"code" text NOT NULL,
	"scale" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_code_chk" CHECK ("assets"."code" ~ '^[A-Z][A-Z0-9_]{1,31}$'),
	CONSTRAINT "assets_scale_chk" CHECK ("assets"."scale" between 0 and 18)
);
--> statement-breakpoint
CREATE TABLE "balance_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"event_type" "balance_snapshot_event_type" NOT NULL,
	"source_id" uuid NOT NULL,
	"posted_minor" bigint NOT NULL,
	"reserved_delta_minor" bigint NOT NULL,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_grant_capacity_versions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"source_entry_id" uuid,
	"source_allocation_id" uuid,
	"source_hold_id" uuid,
	"version" bigint NOT NULL,
	"granted_minor" bigint NOT NULL,
	"reversed_minor" bigint NOT NULL,
	"consumed_minor" bigint NOT NULL,
	"compensated_minor" bigint NOT NULL,
	"expired_minor" bigint NOT NULL,
	"remaining_minor" bigint NOT NULL,
	"reserved_minor" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grant_capacity_versions_reserved_chk" CHECK ("credit_grant_capacity_versions"."reserved_minor" >= 0 and "credit_grant_capacity_versions"."reserved_minor" <= "credit_grant_capacity_versions"."remaining_minor"),
	CONSTRAINT "credit_grant_capacity_versions_version_nonnegative_chk" CHECK ("credit_grant_capacity_versions"."version" >= 0),
	CONSTRAINT "credit_grant_capacity_versions_totals_nonnegative_chk" CHECK ("credit_grant_capacity_versions"."granted_minor" >= 0 and "credit_grant_capacity_versions"."reversed_minor" >= 0 and "credit_grant_capacity_versions"."consumed_minor" >= 0 and "credit_grant_capacity_versions"."compensated_minor" >= 0 and "credit_grant_capacity_versions"."expired_minor" >= 0 and "credit_grant_capacity_versions"."remaining_minor" >= 0),
	CONSTRAINT "credit_grant_capacity_versions_remaining_chk" CHECK ("credit_grant_capacity_versions"."remaining_minor" = "credit_grant_capacity_versions"."granted_minor" + "credit_grant_capacity_versions"."compensated_minor" - "credit_grant_capacity_versions"."reversed_minor" - "credit_grant_capacity_versions"."consumed_minor" - "credit_grant_capacity_versions"."expired_minor")
);
--> statement-breakpoint
CREATE TABLE "credit_grant_entries" (
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"kind" "credit_grant_entry_kind" NOT NULL,
	"amount_minor" bigint NOT NULL,
	CONSTRAINT "credit_grant_entries_pk" PRIMARY KEY("grant_id","entry_id"),
	CONSTRAINT "credit_grant_entries_amount_positive_chk" CHECK ("credit_grant_entries"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_grant_hold_allocations" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"hold_entry_id" uuid NOT NULL,
	"amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grant_hold_allocations_amount_positive_chk" CHECK ("credit_grant_hold_allocations"."amount_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE "credit_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"funding_account_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"external_reference" text,
	"transaction_id" uuid NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "credit_grants_accounts_chk" CHECK ("credit_grants"."account_id" <> "credit_grants"."funding_account_id")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"transaction_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"signed_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_signed_amount_nonzero_chk" CHECK ("entries"."signed_amount_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "hold_entries" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hold_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"signed_amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hold_entries_signed_amount_nonzero_chk" CHECK ("hold_entries"."signed_amount_minor" <> 0)
);
--> statement-breakpoint
CREATE TABLE "holds" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"reference" text NOT NULL,
	"currency" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"description" text,
	"state" "hold_state" DEFAULT 'HELD' NOT NULL,
	"original_amount_minor" bigint NOT NULL,
	"remaining_amount_minor" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	"voided_at" timestamp with time zone,
	CONSTRAINT "holds_amounts_chk" CHECK ("holds"."original_amount_minor" > 0 and "holds"."remaining_amount_minor" >= 0 and "holds"."remaining_amount_minor" <= "holds"."original_amount_minor"),
	CONSTRAINT "holds_state_amount_chk" CHECK (("holds"."state" = 'HELD' and "holds"."remaining_amount_minor" > 0) or ("holds"."state" in ('APPLIED', 'VOIDED') and "holds"."remaining_amount_minor" = 0))
);
--> statement-breakpoint
CREATE TABLE "ledgers" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_records" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"source" text NOT NULL,
	"amount_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"reference" text NOT NULL,
	"description" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_results" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"external_record_id" uuid,
	"external_id" text,
	"transaction_id" uuid,
	"status" "reconciliation_result_status" NOT NULL,
	"reason" text NOT NULL,
	"candidate_transaction_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_rules" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"criteria" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recon_runs" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"status" "reconciliation_run_status" DEFAULT 'pending' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"matched_count" bigint DEFAULT 0 NOT NULL,
	"unmatched_external_count" bigint DEFAULT 0 NOT NULL,
	"unmatched_internal_count" bigint DEFAULT 0 NOT NULL,
	"mismatched_count" bigint DEFAULT 0 NOT NULL,
	"conflict_count" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "recon_runs_strategy_ck" CHECK ("recon_runs"."strategy" = 'one_to_one')
);
--> statement-breakpoint
CREATE TABLE "recon_uploads" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"record_count" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT uuid_v7() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ledger_id" uuid NOT NULL,
	"hold_id" uuid,
	"related_transaction_id" uuid,
	"relation_type" "transaction_relation_type",
	"reference" text NOT NULL,
	"currency" text NOT NULL,
	"asset_id" uuid NOT NULL,
	"description" text,
	"metadata" jsonb,
	"effective_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transactions_relation_pair_ck" CHECK (("transactions"."related_transaction_id" is null and "transactions"."relation_type" is null) or ("transactions"."related_transaction_id" is not null and "transactions"."relation_type" is not null)),
	CONSTRAINT "transactions_metadata_object_chk" CHECK ("transactions"."metadata" is null or jsonb_typeof("transactions"."metadata") = 'object'),
	CONSTRAINT "transactions_metadata_size_chk" CHECK ("transactions"."metadata" is null or octet_length("transactions"."metadata"::text) <= 16384)
);
--> statement-breakpoint
CREATE INDEX "accounts_tenant_id_idx" ON "accounts" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "accounts_ledger_id_idx" ON "accounts" USING btree ("ledger_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_tenant_ledger_id_uq" ON "accounts" USING btree ("tenant_id","ledger_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_ledger_code_uq" ON "accounts" USING btree ("tenant_id","ledger_id","code") WHERE "accounts"."code" is not null;
--> statement-breakpoint
CREATE INDEX "api_keys_tenant_id_idx" ON "api_keys" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_uq" ON "api_keys" USING btree ("key_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_code_uq" ON "assets" USING btree ("tenant_id","code");
--> statement-breakpoint
CREATE UNIQUE INDEX "assets_tenant_id_uq" ON "assets" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE INDEX "balance_snapshots_as_of_idx" ON "balance_snapshots" USING btree ("tenant_id","account_id","effective_at");
--> statement-breakpoint
CREATE INDEX "balance_snapshots_source_idx" ON "balance_snapshots" USING btree ("tenant_id","source_id","event_type");
--> statement-breakpoint
CREATE UNIQUE INDEX "balance_snapshots_dedup_uq" ON "balance_snapshots" USING btree ("tenant_id","event_type","source_id","account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_capacity_versions_grant_version_uq" ON "credit_grant_capacity_versions" USING btree ("grant_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_capacity_versions_source_entry_uq" ON "credit_grant_capacity_versions" USING btree ("grant_id","source_entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_capacity_versions_source_allocation_uq" ON "credit_grant_capacity_versions" USING btree ("source_allocation_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_capacity_versions_source_hold_uq" ON "credit_grant_capacity_versions" USING btree ("grant_id","source_hold_id");
--> statement-breakpoint
CREATE INDEX "credit_grant_capacity_versions_tenant_grant_version_idx" ON "credit_grant_capacity_versions" USING btree ("tenant_id","grant_id","version");
--> statement-breakpoint
CREATE INDEX "credit_grant_entries_tenant_grant_idx" ON "credit_grant_entries" USING btree ("tenant_id","grant_id");
--> statement-breakpoint
CREATE INDEX "credit_grant_entries_tenant_account_idx" ON "credit_grant_entries" USING btree ("tenant_id","account_id");
--> statement-breakpoint
CREATE INDEX "credit_grant_entries_tenant_entry_idx" ON "credit_grant_entries" USING btree ("tenant_id","entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_entries_one_issuance_uq" ON "credit_grant_entries" USING btree ("grant_id") WHERE "credit_grant_entries"."kind" = 'ISSUANCE';
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_entries_one_reversal_uq" ON "credit_grant_entries" USING btree ("grant_id") WHERE "credit_grant_entries"."kind" = 'REVERSAL';
--> statement-breakpoint
CREATE INDEX "credit_grant_hold_allocations_grant_idx" ON "credit_grant_hold_allocations" USING btree ("tenant_id","grant_id");
--> statement-breakpoint
CREATE INDEX "credit_grant_hold_allocations_hold_entry_idx" ON "credit_grant_hold_allocations" USING btree ("tenant_id","hold_entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grant_hold_allocations_grant_hold_entry_uq" ON "credit_grant_hold_allocations" USING btree ("grant_id","hold_entry_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_tenant_reference_uq" ON "credit_grants" USING btree ("tenant_id","reference");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_tenant_ledger_account_id_uq" ON "credit_grants" USING btree ("tenant_id","ledger_id","account_id","id");
--> statement-breakpoint
CREATE INDEX "credit_grants_tenant_account_created_id_idx" ON "credit_grants" USING btree ("tenant_id","account_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "credit_grants_tenant_created_id_idx" ON "credit_grants" USING btree ("tenant_id","created_at","id");
--> statement-breakpoint
CREATE INDEX "credit_grants_tenant_due_idx" ON "credit_grants" USING btree ("tenant_id","expires_at","created_at","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "credit_grants_transaction_uq" ON "credit_grants" USING btree ("transaction_id");
--> statement-breakpoint
CREATE INDEX "entries_tenant_id_idx" ON "entries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "entries_transaction_id_idx" ON "entries" USING btree ("transaction_id");
--> statement-breakpoint
CREATE INDEX "entries_account_id_idx" ON "entries" USING btree ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entries_tenant_account_id_uq" ON "entries" USING btree ("tenant_id","account_id","id");
--> statement-breakpoint
CREATE INDEX "hold_entries_tenant_id_idx" ON "hold_entries" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "hold_entries_hold_id_idx" ON "hold_entries" USING btree ("hold_id");
--> statement-breakpoint
CREATE INDEX "hold_entries_account_id_idx" ON "hold_entries" USING btree ("account_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "hold_entries_tenant_account_id_uq" ON "hold_entries" USING btree ("tenant_id","account_id","id");
--> statement-breakpoint
CREATE UNIQUE INDEX "holds_tenant_reference_uq" ON "holds" USING btree ("tenant_id","reference");
--> statement-breakpoint
CREATE INDEX "holds_ledger_id_idx" ON "holds" USING btree ("ledger_id");
--> statement-breakpoint
CREATE INDEX "ledgers_tenant_id_idx" ON "ledgers" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ledgers_tenant_id_uq" ON "ledgers" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE INDEX "recon_records_upload_idx" ON "recon_records" USING btree ("tenant_id","upload_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "recon_records_source_external_uq" ON "recon_records" USING btree ("tenant_id","source","external_id");
--> statement-breakpoint
CREATE INDEX "recon_results_run_idx" ON "recon_results" USING btree ("run_id");
--> statement-breakpoint
CREATE INDEX "recon_results_tenant_status_idx" ON "recon_results" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "recon_rules_tenant_idx" ON "recon_rules" USING btree ("tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "recon_rules_tenant_name_uq" ON "recon_rules" USING btree ("tenant_id","name");
--> statement-breakpoint
CREATE INDEX "recon_runs_tenant_idx" ON "recon_runs" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "recon_runs_upload_idx" ON "recon_runs" USING btree ("upload_id");
--> statement-breakpoint
CREATE INDEX "recon_uploads_tenant_idx" ON "recon_uploads" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "recon_uploads_source_idx" ON "recon_uploads" USING btree ("tenant_id","source");
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_reference_uq" ON "transactions" USING btree ("tenant_id","reference");
--> statement-breakpoint
CREATE INDEX "transactions_effective_at_idx" ON "transactions" USING btree ("tenant_id","effective_at");
--> statement-breakpoint
CREATE INDEX "transactions_ledger_id_idx" ON "transactions" USING btree ("ledger_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_tenant_ledger_id_uq" ON "transactions" USING btree ("tenant_id","ledger_id","id");
--> statement-breakpoint
CREATE INDEX "transactions_hold_id_idx" ON "transactions" USING btree ("hold_id");
--> statement-breakpoint
CREATE INDEX "transactions_related_transaction_id_idx" ON "transactions" USING btree ("related_transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_relation_uq" ON "transactions" USING btree ("tenant_id","relation_type","related_transaction_id") WHERE "transactions"."related_transaction_id" is not null;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "balance_snapshots" ADD CONSTRAINT "balance_snapshots_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "credit_grant_capacity_versions" ADD CONSTRAINT "credit_grant_capacity_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_capacity_versions" ADD CONSTRAINT "credit_grant_capacity_versions_source_allocation_id_credit_grant_hold_allocations_id_fk" FOREIGN KEY ("source_allocation_id") REFERENCES "public"."credit_grant_hold_allocations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_capacity_versions" ADD CONSTRAINT "credit_grant_capacity_versions_source_hold_id_holds_id_fk" FOREIGN KEY ("source_hold_id") REFERENCES "public"."holds"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_capacity_versions" ADD CONSTRAINT "credit_grant_capacity_versions_grant_fk" FOREIGN KEY ("tenant_id","ledger_id","account_id","grant_id") REFERENCES "public"."credit_grants"("tenant_id","ledger_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_capacity_versions" ADD CONSTRAINT "credit_grant_capacity_versions_source_entry_fk" FOREIGN KEY ("grant_id","source_entry_id") REFERENCES "public"."credit_grant_entries"("grant_id","entry_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_entries" ADD CONSTRAINT "credit_grant_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_entries" ADD CONSTRAINT "credit_grant_entries_grant_fk" FOREIGN KEY ("tenant_id","ledger_id","account_id","grant_id") REFERENCES "public"."credit_grants"("tenant_id","ledger_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_entries" ADD CONSTRAINT "credit_grant_entries_entry_fk" FOREIGN KEY ("tenant_id","account_id","entry_id") REFERENCES "public"."entries"("tenant_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_hold_allocations" ADD CONSTRAINT "credit_grant_hold_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_hold_allocations" ADD CONSTRAINT "credit_grant_hold_allocations_grant_fk" FOREIGN KEY ("tenant_id","ledger_id","account_id","grant_id") REFERENCES "public"."credit_grants"("tenant_id","ledger_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grant_hold_allocations" ADD CONSTRAINT "credit_grant_hold_allocations_hold_entry_fk" FOREIGN KEY ("tenant_id","account_id","hold_entry_id") REFERENCES "public"."hold_entries"("tenant_id","account_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_tenant_ledger_fk" FOREIGN KEY ("tenant_id","ledger_id") REFERENCES "public"."ledgers"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_account_scope_fk" FOREIGN KEY ("tenant_id","ledger_id","account_id") REFERENCES "public"."accounts"("tenant_id","ledger_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_funding_account_scope_fk" FOREIGN KEY ("tenant_id","ledger_id","funding_account_id") REFERENCES "public"."accounts"("tenant_id","ledger_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "credit_grants" ADD CONSTRAINT "credit_grants_transaction_scope_fk" FOREIGN KEY ("tenant_id","ledger_id","transaction_id") REFERENCES "public"."transactions"("tenant_id","ledger_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "entries" ADD CONSTRAINT "entries_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "hold_entries" ADD CONSTRAINT "hold_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "hold_entries" ADD CONSTRAINT "hold_entries_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "hold_entries" ADD CONSTRAINT "hold_entries_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "hold_entries" ADD CONSTRAINT "hold_entries_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "holds" ADD CONSTRAINT "holds_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "ledgers" ADD CONSTRAINT "ledgers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_records" ADD CONSTRAINT "recon_records_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_records" ADD CONSTRAINT "recon_records_upload_id_recon_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."recon_uploads"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_results" ADD CONSTRAINT "recon_results_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_results" ADD CONSTRAINT "recon_results_run_id_recon_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."recon_runs"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_results" ADD CONSTRAINT "recon_results_external_record_id_recon_records_id_fk" FOREIGN KEY ("external_record_id") REFERENCES "public"."recon_records"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_results" ADD CONSTRAINT "recon_results_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_rules" ADD CONSTRAINT "recon_rules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_runs" ADD CONSTRAINT "recon_runs_upload_id_recon_uploads_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."recon_uploads"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "recon_uploads" ADD CONSTRAINT "recon_uploads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_ledger_id_ledgers_id_fk" FOREIGN KEY ("ledger_id") REFERENCES "public"."ledgers"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_hold_id_holds_id_fk" FOREIGN KEY ("hold_id") REFERENCES "public"."holds"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_related_transaction_id_transactions_id_fk" FOREIGN KEY ("related_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE restrict ON UPDATE cascade;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_asset_fk" FOREIGN KEY ("tenant_id","asset_id") REFERENCES "public"."assets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- PostgreSQL functions, triggers, policies, and comments outside the Drizzle schema.
CREATE FUNCTION public.account_asset_history_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.asset_id <> OLD.asset_id AND (
    EXISTS (SELECT 1 FROM entries WHERE account_id = OLD.id)
    OR EXISTS (SELECT 1 FROM hold_entries WHERE account_id = OLD.id)
  ) THEN
    RAISE EXCEPTION 'Account asset cannot change after ledger history exists';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.active_credit_grant_reservation(p_tenant uuid, p_grant uuid) RETURNS numeric
    LANGUAGE sql
    AS $$
  SELECT coalesce((SELECT reserved_minor FROM credit_grant_capacity_versions
    WHERE tenant_id = p_tenant AND grant_id = p_grant ORDER BY version DESC LIMIT 1), 0)::numeric;
$$;
--> statement-breakpoint
CREATE FUNCTION public.append_credit_grant_capacity_version() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE previous_version bigint := 0;
DECLARE granted_amount bigint := 0;
DECLARE reversed_amount bigint := 0;
DECLARE consumed_amount bigint := 0;
DECLARE compensated_amount bigint := 0;
DECLARE expired_amount bigint := 0;
DECLARE remaining_amount bigint := 0;
BEGIN
  SELECT version, granted_minor, reversed_minor, consumed_minor, compensated_minor,
         expired_minor, remaining_minor
    INTO previous_version, granted_amount, reversed_amount, consumed_amount,
         compensated_amount, expired_amount, remaining_amount
    FROM credit_grant_capacity_versions
    WHERE tenant_id = NEW.tenant_id AND grant_id = NEW.grant_id
    ORDER BY version DESC LIMIT 1;

  previous_version := coalesce(previous_version, 0);
  granted_amount := coalesce(granted_amount, 0);
  reversed_amount := coalesce(reversed_amount, 0);
  consumed_amount := coalesce(consumed_amount, 0);
  compensated_amount := coalesce(compensated_amount, 0);
  expired_amount := coalesce(expired_amount, 0);
  remaining_amount := coalesce(remaining_amount, 0);

  IF NEW.kind::text = 'ISSUANCE' THEN
    granted_amount := granted_amount + NEW.amount_minor;
    remaining_amount := remaining_amount + NEW.amount_minor;
  ELSIF NEW.kind::text IN ('REVERSAL', 'REFUND') THEN
    reversed_amount := reversed_amount + NEW.amount_minor;
    remaining_amount := remaining_amount - NEW.amount_minor;
  ELSIF NEW.kind::text = 'CONSUMPTION' THEN
    consumed_amount := consumed_amount + NEW.amount_minor;
    remaining_amount := remaining_amount - NEW.amount_minor;
  ELSIF NEW.kind::text = 'COMPENSATION' THEN
    compensated_amount := compensated_amount + NEW.amount_minor;
    remaining_amount := remaining_amount + NEW.amount_minor;
  ELSIF NEW.kind::text = 'EXPIRATION' THEN
    expired_amount := expired_amount + NEW.amount_minor;
    remaining_amount := remaining_amount - NEW.amount_minor;
  ELSE
    RAISE EXCEPTION 'unsupported credit grant capacity transition';
  END IF;

  INSERT INTO credit_grant_capacity_versions (
    tenant_id, ledger_id, account_id, grant_id, source_entry_id, version,
    granted_minor, reversed_minor, consumed_minor, compensated_minor,
    expired_minor, remaining_minor
  ) VALUES (
    NEW.tenant_id, NEW.ledger_id, NEW.account_id, NEW.grant_id, NEW.entry_id,
    previous_version + 1, granted_amount, reversed_amount, consumed_amount,
    compensated_amount, expired_amount, remaining_amount
  );
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.append_credit_grant_reservation_version(p_tenant uuid, p_grant uuid, p_delta bigint, p_allocation uuid, p_hold uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION 'reservation versions require a reservation event';
  END IF;
  PERFORM 1 FROM credit_grants WHERE tenant_id = p_tenant AND id = p_grant FOR UPDATE;
  INSERT INTO credit_grant_capacity_versions (
    tenant_id, ledger_id, account_id, grant_id, version, source_allocation_id, source_hold_id,
    granted_minor, reversed_minor, consumed_minor, compensated_minor, expired_minor,
    remaining_minor, reserved_minor
  ) SELECT tenant_id, ledger_id, account_id, grant_id, version + 1, p_allocation, p_hold,
    granted_minor, reversed_minor, consumed_minor, compensated_minor, expired_minor,
    remaining_minor, reserved_minor + p_delta
  FROM credit_grant_capacity_versions
  WHERE tenant_id = p_tenant AND grant_id = p_grant ORDER BY version DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'reservation requires an issued grant'; END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.append_grant_allocation_reservation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  PERFORM append_credit_grant_reservation_version(NEW.tenant_id, NEW.grant_id,
    NEW.amount_minor, NEW.id, NULL);
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_expired_grant_capacity_removed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE grant_expiration timestamptz;
DECLARE remaining_amount bigint;
DECLARE reserved_amount bigint;
BEGIN
  IF NEW.kind::text NOT IN ('COMPENSATION', 'EXPIRATION') THEN
    RETURN NEW;
  END IF;
  SELECT expires_at INTO grant_expiration FROM credit_grants
    WHERE tenant_id = NEW.tenant_id AND id = NEW.grant_id;
  IF grant_expiration IS NULL OR grant_expiration > transaction_timestamp() THEN
    RETURN NEW;
  END IF;
  SELECT remaining_minor INTO remaining_amount
    FROM credit_grant_capacity_versions
    WHERE tenant_id = NEW.tenant_id AND grant_id = NEW.grant_id
    ORDER BY version DESC LIMIT 1;
  SELECT active_credit_grant_reservation(NEW.tenant_id, NEW.grant_id) INTO reserved_amount;
  IF coalesce(remaining_amount, 0) <> reserved_amount THEN
    RAISE EXCEPTION 'expired credit grant cannot retain unreserved capacity';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_grant_allocation_total() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE held_amount bigint;
DECLARE allocated numeric;
BEGIN
  SELECT signed_amount_minor INTO held_amount FROM hold_entries
    WHERE tenant_id = NEW.tenant_id AND id = NEW.hold_entry_id;
  SELECT sum(amount_minor) INTO allocated FROM credit_grant_hold_allocations
    WHERE tenant_id = NEW.tenant_id AND hold_entry_id = NEW.hold_entry_id;
  IF allocated IS DISTINCT FROM held_amount::numeric THEN
    RAISE EXCEPTION 'grant hold allocation total must match immutable hold entry';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_grant_compensation_complete() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE linked_transaction uuid;
DECLARE related_transaction uuid;
DECLARE source_allocation bigint;
DECLARE compensated_amount bigint;
BEGIN
  IF NEW.kind::text <> 'COMPENSATION' THEN
    RETURN NEW;
  END IF;
  SELECT e.transaction_id, t.related_transaction_id
    INTO linked_transaction, related_transaction
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id AND t.tenant_id = e.tenant_id
    WHERE e.id = NEW.entry_id AND e.tenant_id = NEW.tenant_id;
  SELECT
    coalesce(sum(l.amount_minor) FILTER (
      WHERE l.kind::text = 'CONSUMPTION' AND e.transaction_id = related_transaction
    ), 0),
    coalesce(sum(l.amount_minor) FILTER (
      WHERE l.kind::text = 'COMPENSATION' AND e.transaction_id = linked_transaction
    ), 0)
    INTO source_allocation, compensated_amount
    FROM credit_grant_entries l
    JOIN entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
    WHERE l.tenant_id = NEW.tenant_id AND l.grant_id = NEW.grant_id;
  IF source_allocation = 0 OR compensated_amount <> source_allocation THEN
    RAISE EXCEPTION 'credit grant compensation must exactly restore original allocation';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_grant_entry_attributed() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE attributed_amount bigint;
DECLARE linked_relation transaction_relation_type;
DECLARE related_transaction uuid;
DECLARE original_amount bigint;
DECLARE reversal_amount bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounts
      WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id AND grant_enabled
  ) THEN
    SELECT coalesce(sum(amount_minor), 0) INTO attributed_amount
      FROM credit_grant_entries
      WHERE tenant_id = NEW.tenant_id AND entry_id = NEW.id;
    IF attributed_amount <> abs(NEW.signed_amount_minor) THEN
      RAISE EXCEPTION 'grant-enabled account entry requires complete grant attribution';
    END IF;
    SELECT relation_type, related_transaction_id INTO linked_relation, related_transaction
      FROM transactions WHERE id = NEW.transaction_id AND tenant_id = NEW.tenant_id;
    IF linked_relation::text = 'REVERSAL' THEN
      SELECT coalesce(sum(abs(signed_amount_minor)), 0) INTO original_amount
        FROM entries
        WHERE tenant_id = NEW.tenant_id AND transaction_id = related_transaction
          AND account_id = NEW.account_id
          AND ((signed_amount_minor < 0 AND NEW.signed_amount_minor > 0)
            OR (signed_amount_minor > 0 AND NEW.signed_amount_minor < 0));
      SELECT coalesce(sum(abs(signed_amount_minor)), 0) INTO reversal_amount
        FROM entries
        WHERE tenant_id = NEW.tenant_id AND transaction_id = NEW.transaction_id
          AND account_id = NEW.account_id
          AND ((signed_amount_minor > 0 AND NEW.signed_amount_minor > 0)
            OR (signed_amount_minor < 0 AND NEW.signed_amount_minor < 0));
      IF original_amount = 0 OR reversal_amount <> original_amount THEN
        RAISE EXCEPTION 'grant-enabled account reversal must exactly mirror original entries';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_grant_hold_allocated() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE allocated bigint;
BEGIN
  IF EXISTS (
    SELECT 1 FROM accounts
    WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id AND grant_enabled
  ) THEN
    IF NEW.signed_amount_minor <= 0 THEN
      RAISE EXCEPTION 'grant-enabled account hold requires debit grant allocation';
    END IF;
    SELECT coalesce(sum(amount_minor), 0) INTO allocated
      FROM credit_grant_hold_allocations
      WHERE tenant_id = NEW.tenant_id AND hold_entry_id = NEW.id;
    IF allocated <> NEW.signed_amount_minor THEN
      RAISE EXCEPTION 'grant-enabled account hold requires complete grant allocation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.assert_grant_hold_consistent(p_tenant uuid, p_hold uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE h holds%ROWTYPE;
DECLARE initial numeric;
DECLARE committed numeric;
DECLARE net numeric;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hold_entries he JOIN accounts a
    ON a.tenant_id = he.tenant_id AND a.id = he.account_id
    WHERE he.tenant_id = p_tenant AND he.hold_id = p_hold AND a.grant_enabled) THEN RETURN; END IF;
  SELECT * INTO STRICT h FROM holds WHERE tenant_id = p_tenant AND id = p_hold;
  SELECT coalesce(sum(signed_amount_minor) FILTER (WHERE signed_amount_minor > 0), 0),
    coalesce(sum(signed_amount_minor), 0) INTO initial, net
    FROM hold_entries WHERE tenant_id = p_tenant AND hold_id = p_hold;
  IF initial <> h.original_amount_minor OR net <> 0 THEN
    RAISE EXCEPTION 'hold entries do not match original amount' USING ERRCODE = 'LL001';
  END IF;
  SELECT coalesce(sum(e.signed_amount_minor) FILTER (WHERE e.signed_amount_minor > 0), 0),
    coalesce(sum(e.signed_amount_minor), 0) INTO committed, net
    FROM transactions t JOIN entries e ON e.tenant_id = t.tenant_id AND e.transaction_id = t.id
    WHERE t.tenant_id = p_tenant AND t.hold_id = p_hold;
  IF net <> 0 OR committed > initial
    OR (h.state = 'HELD' AND h.remaining_amount_minor <> initial - committed)
    OR (h.state = 'APPLIED' AND committed <> initial)
    OR (h.state = 'VOIDED' AND committed >= initial) THEN
    RAISE EXCEPTION 'hold amounts disagree with committed postings' USING ERRCODE = 'LL001';
  END IF;
  IF EXISTS (
    WITH original AS (
      SELECT account_id, sign(signed_amount_minor) AS side, sum(abs(signed_amount_minor::numeric)) AS amount
      FROM hold_entries WHERE tenant_id = p_tenant AND hold_id = p_hold GROUP BY account_id, side
    ), posted AS (
      SELECT e.account_id, sign(e.signed_amount_minor) AS side, sum(abs(e.signed_amount_minor::numeric)) AS amount
      FROM transactions t JOIN entries e ON e.tenant_id = t.tenant_id AND e.transaction_id = t.id
      WHERE t.tenant_id = p_tenant AND t.hold_id = p_hold GROUP BY e.account_id, side
    ) SELECT 1 FROM original o FULL JOIN posted p USING (account_id, side)
      WHERE coalesce(p.amount, 0) * initial <> coalesce(o.amount, 0) * committed
  ) THEN
    RAISE EXCEPTION 'hold posting proportions do not match original entries' USING ERRCODE = 'LL001';
  END IF;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.asset_identity_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.code <> OLD.code OR NEW.scale <> OLD.scale THEN
    RAISE EXCEPTION 'Asset code and scale are immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.check_grant_hold_consistency() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE linked_hold uuid;
BEGIN
  IF TG_TABLE_NAME = 'holds' THEN linked_hold := NEW.id;
  ELSIF TG_TABLE_NAME = 'hold_entries' THEN linked_hold := NEW.hold_id;
  ELSE
    SELECT hold_id INTO linked_hold FROM transactions WHERE tenant_id = NEW.tenant_id AND id = NEW.transaction_id;
  END IF;
  IF linked_hold IS NOT NULL THEN PERFORM assert_grant_hold_consistent(NEW.tenant_id, linked_hold); END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.guard_hold_lifecycle() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'hold history is immutable' USING ERRCODE = 'LL001';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'HELD' OR NEW.original_amount_minor <= 0
      OR NEW.remaining_amount_minor <> NEW.original_amount_minor
      OR NEW.applied_at IS NOT NULL OR NEW.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'hold must start with its full reservation' USING ERRCODE = 'LL001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.ledger_id, NEW.asset_id, NEW.currency,
      NEW.reference, NEW.description, NEW.original_amount_minor, NEW.created_at)
    IS DISTINCT FROM (OLD.id, OLD.tenant_id, OLD.ledger_id, OLD.asset_id, OLD.currency,
      OLD.reference, OLD.description, OLD.original_amount_minor, OLD.created_at) THEN
    RAISE EXCEPTION 'hold identity is immutable' USING ERRCODE = 'LL001';
  END IF;
  IF OLD.state <> 'HELD' THEN
    RAISE EXCEPTION 'finalized hold cannot transition' USING ERRCODE = 'LL001';
  END IF;
  IF NEW.state = 'HELD' AND NEW.remaining_amount_minor > 0
    AND NEW.remaining_amount_minor < OLD.remaining_amount_minor
    AND NEW.applied_at IS NULL AND NEW.voided_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.state = 'APPLIED' AND NEW.remaining_amount_minor = 0
    AND NEW.applied_at IS NOT NULL AND NEW.voided_at IS NULL THEN RETURN NEW; END IF;
  IF NEW.state = 'VOIDED' AND NEW.remaining_amount_minor = 0
    AND NEW.applied_at IS NULL AND NEW.voided_at IS NOT NULL THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'invalid hold lifecycle transition' USING ERRCODE = 'LL001';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.protect_allocated_hold_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM credit_grant_hold_allocations
    WHERE tenant_id = OLD.tenant_id AND hold_entry_id = OLD.id) THEN
    RAISE EXCEPTION 'allocated hold entries are immutable';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.protect_credit_grant_history() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_TABLE_NAME = 'entries' THEN
    IF EXISTS (SELECT 1 FROM credit_grant_entries WHERE entry_id = OLD.id) THEN
      RAISE EXCEPTION 'credit grant ledger entries are immutable';
    END IF;
  ELSIF TG_TABLE_NAME = 'transactions' THEN
    IF EXISTS (
      SELECT 1 FROM entries e JOIN credit_grant_entries l ON l.entry_id = e.id
        WHERE e.transaction_id = OLD.id
    ) THEN
      RAISE EXCEPTION 'credit grant transactions are immutable';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.protect_transaction_metadata() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.metadata IS DISTINCT FROM NEW.metadata THEN
    RAISE EXCEPTION 'transaction metadata is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_credit_grant_capacity_baseline_insert() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE linked_hold uuid;
DECLARE lineage credit_grant_entries%ROWTYPE;
BEGIN
  IF pg_trigger_depth() < 2 OR num_nonnulls(NEW.source_entry_id,
      NEW.source_allocation_id, NEW.source_hold_id) <> 1 THEN
    RAISE EXCEPTION 'credit grant capacity versions can only be appended from lineage or reservation events';
  END IF;
  IF NEW.source_entry_id IS NOT NULL THEN
    NEW.reserved_minor := active_credit_grant_reservation(NEW.tenant_id, NEW.grant_id);
    SELECT * INTO STRICT lineage FROM credit_grant_entries
      WHERE tenant_id = NEW.tenant_id AND grant_id = NEW.grant_id AND entry_id = NEW.source_entry_id;
    IF lineage.kind = 'CONSUMPTION' THEN
      SELECT t.hold_id INTO linked_hold FROM entries e
      JOIN transactions t ON t.tenant_id = e.tenant_id AND t.id = e.transaction_id
      WHERE e.tenant_id = NEW.tenant_id AND e.id = NEW.source_entry_id;
      IF linked_hold IS NOT NULL THEN
        IF NEW.reserved_minor < lineage.amount_minor THEN
          RAISE EXCEPTION 'credit grant consumption exceeds reserved capacity' USING ERRCODE = 'LL002';
        END IF;
        NEW.reserved_minor := NEW.reserved_minor - lineage.amount_minor;
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_credit_grant_hold_allocation_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'credit grant hold allocations are immutable';
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_credit_grant_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'credit grant history is immutable'; END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_expiring_grant_enabled_funding() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.expires_at IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM 1
    FROM accounts
    WHERE tenant_id = NEW.tenant_id
      AND id IN (NEW.account_id, NEW.funding_account_id)
    ORDER BY id
    FOR UPDATE;

  IF EXISTS (
    SELECT 1
    FROM credit_grants
    WHERE tenant_id = NEW.tenant_id
      AND account_id = NEW.funding_account_id
  ) THEN
    RAISE EXCEPTION 'expiring credit grant funding account cannot be grant-enabled';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.reject_grant_capability_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.grant_enabled IS DISTINCT FROM NEW.grant_enabled THEN
    RAISE EXCEPTION 'account grant capability is immutable';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.release_grant_hold_reservations() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE grant_row record;
DECLARE allocated bigint;
DECLARE consumed bigint;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hold_entries he JOIN credit_grant_hold_allocations a
      ON a.tenant_id = he.tenant_id AND a.hold_entry_id = he.id
      WHERE he.tenant_id = OLD.tenant_id AND he.hold_id = OLD.id) THEN
    RETURN NEW;
  END IF;
  IF NEW.state <> 'VOIDED' THEN RETURN NEW; END IF;
  PERFORM 1 FROM accounts ac WHERE ac.tenant_id = OLD.tenant_id AND ac.grant_enabled
    AND ac.id IN (SELECT account_id FROM hold_entries WHERE tenant_id = OLD.tenant_id AND hold_id = OLD.id)
    ORDER BY ac.id FOR UPDATE;
  FOR grant_row IN
    SELECT g.id FROM credit_grants g WHERE g.tenant_id = OLD.tenant_id AND g.id IN (
      SELECT a.grant_id FROM credit_grant_hold_allocations a JOIN hold_entries he
        ON he.tenant_id = a.tenant_id AND he.id = a.hold_entry_id
      WHERE he.tenant_id = OLD.tenant_id AND he.hold_id = OLD.id
    ) ORDER BY g.account_id, g.expires_at ASC NULLS LAST, g.created_at, g.id FOR UPDATE
  LOOP
    SELECT sum(a.amount_minor) INTO allocated FROM credit_grant_hold_allocations a
      JOIN hold_entries he ON he.tenant_id = a.tenant_id AND he.id = a.hold_entry_id
      WHERE a.tenant_id = OLD.tenant_id AND a.grant_id = grant_row.id AND he.hold_id = OLD.id;
    SELECT coalesce(sum(l.amount_minor), 0) INTO consumed FROM credit_grant_entries l
      JOIN entries e ON e.tenant_id = l.tenant_id AND e.id = l.entry_id
      JOIN transactions t ON t.tenant_id = e.tenant_id AND t.id = e.transaction_id
      WHERE l.tenant_id = OLD.tenant_id AND l.grant_id = grant_row.id
        AND l.kind = 'CONSUMPTION' AND t.hold_id = OLD.id;
    IF allocated < consumed THEN
      RAISE EXCEPTION 'allocated hold finalization does not match consumption' USING ERRCODE = 'LL001';
    END IF;
    IF allocated > consumed THEN
      PERFORM append_credit_grant_reservation_version(OLD.tenant_id, grant_row.id,
        consumed - allocated, NULL, OLD.id);
    END IF;
  END LOOP;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.require_grant_enabled_account() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM accounts
      WHERE tenant_id = NEW.tenant_id AND id = NEW.account_id AND grant_enabled
  ) THEN
    RAISE EXCEPTION 'credit grants require a grant-enabled account';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.validate_credit_grant_entry() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE source_transaction uuid;
DECLARE grant_expiration timestamptz;
DECLARE funding_account uuid;
DECLARE linked_transaction uuid;
DECLARE linked_hold uuid;
DECLARE linked_signed_amount bigint;
DECLARE linked_relation transaction_relation_type;
DECLARE related_transaction uuid;
DECLARE linked_effective_at timestamptz;
DECLARE entry_amount bigint;
DECLARE issuance_amount bigint := 0;
DECLARE available_amount bigint := 0;
DECLARE consumed_amount bigint := 0;
DECLARE expired_amount bigint := 0;
DECLARE reserved_amount bigint := 0;
DECLARE hold_allocation bigint := 0;
DECLARE hold_consumed bigint := 0;
DECLARE source_allocation bigint;
DECLARE compensated_amount bigint;
DECLARE entry_asset uuid;
DECLARE transaction_asset uuid;
DECLARE account_asset uuid;
DECLARE funding_credit bigint;
BEGIN
  SELECT transaction_id, expires_at, funding_account_id
    INTO source_transaction, grant_expiration, funding_account
    FROM credit_grants
    WHERE id = NEW.grant_id AND tenant_id = NEW.tenant_id AND ledger_id = NEW.ledger_id
      AND account_id = NEW.account_id
    FOR UPDATE;
  SELECT e.transaction_id, t.hold_id, e.signed_amount_minor, t.relation_type,
         t.related_transaction_id, t.effective_at, abs(e.signed_amount_minor),
         e.asset_id, t.asset_id, a.asset_id
    INTO linked_transaction, linked_hold, linked_signed_amount, linked_relation,
         related_transaction, linked_effective_at, entry_amount,
         entry_asset, transaction_asset, account_asset
    FROM entries e
    JOIN transactions t ON t.id = e.transaction_id
      AND t.tenant_id = NEW.tenant_id AND t.ledger_id = NEW.ledger_id
    JOIN accounts a ON a.id = e.account_id
      AND a.tenant_id = NEW.tenant_id AND a.ledger_id = NEW.ledger_id
    WHERE e.id = NEW.entry_id AND e.tenant_id = NEW.tenant_id
      AND e.account_id = NEW.account_id;
  IF source_transaction IS NULL OR linked_transaction IS NULL
    OR entry_asset <> account_asset OR transaction_asset <> account_asset
    OR NEW.amount_minor > entry_amount THEN
    RAISE EXCEPTION 'credit grant entry scope or amount mismatch';
  END IF;

  IF NEW.kind::text IN ('REVERSAL', 'CONSUMPTION', 'EXPIRATION', 'REFUND') THEN
    SELECT remaining_minor, granted_minor, consumed_minor, expired_minor
      INTO available_amount, issuance_amount, consumed_amount, expired_amount
      FROM credit_grant_capacity_versions
      WHERE tenant_id = NEW.tenant_id AND grant_id = NEW.grant_id
      ORDER BY version DESC LIMIT 1;
    available_amount := coalesce(available_amount, 0);
    issuance_amount := coalesce(issuance_amount, 0);
    consumed_amount := coalesce(consumed_amount, 0);
    expired_amount := coalesce(expired_amount, 0);
    SELECT active_credit_grant_reservation(NEW.tenant_id, NEW.grant_id) INTO reserved_amount;
  END IF;

  IF NEW.kind::text = 'ISSUANCE' AND NOT (
    linked_transaction = source_transaction AND linked_signed_amount < 0
    AND NEW.amount_minor = entry_amount
    AND (grant_expiration IS NULL OR grant_expiration > transaction_timestamp())
  ) THEN
    RAISE EXCEPTION 'credit grant issuance link is invalid';
  ELSIF NEW.kind::text = 'REVERSAL' AND NOT (
    linked_relation = 'REVERSAL' AND related_transaction = source_transaction
    AND linked_signed_amount > 0 AND NEW.amount_minor = entry_amount
    AND issuance_amount > 0 AND NEW.amount_minor = issuance_amount
    AND available_amount = issuance_amount AND reserved_amount = 0
    AND consumed_amount = 0 AND expired_amount = 0
  ) THEN
    RAISE EXCEPTION 'credit grant reversal link is invalid';
  ELSIF NEW.kind::text = 'CONSUMPTION' THEN
    IF linked_hold IS NULL THEN
      IF linked_signed_amount <= 0 OR NEW.amount_minor > available_amount - reserved_amount
        OR (grant_expiration IS NOT NULL AND (
          grant_expiration <= linked_effective_at OR grant_expiration <= transaction_timestamp()
        )) THEN
        RAISE EXCEPTION 'credit grant consumption exceeds eligible capacity';
      END IF;
    ELSE
      SELECT coalesce(sum(a.amount_minor), 0) INTO hold_allocation
        FROM credit_grant_hold_allocations a
        JOIN hold_entries he ON he.id = a.hold_entry_id AND he.tenant_id = a.tenant_id
        JOIN holds h ON h.id = he.hold_id AND h.tenant_id = he.tenant_id
        WHERE a.tenant_id = NEW.tenant_id AND a.grant_id = NEW.grant_id
          AND h.id = linked_hold AND h.state = 'HELD';
      SELECT coalesce(sum(l.amount_minor), 0) INTO hold_consumed
        FROM credit_grant_entries l
        JOIN entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
        JOIN transactions t ON t.id = e.transaction_id AND t.tenant_id = e.tenant_id
        WHERE l.tenant_id = NEW.tenant_id AND l.grant_id = NEW.grant_id
          AND l.kind = 'CONSUMPTION' AND t.hold_id = linked_hold;
      IF linked_signed_amount <= 0 OR NEW.amount_minor > available_amount
        OR hold_consumed + NEW.amount_minor > hold_allocation THEN
        RAISE EXCEPTION 'credit grant consumption exceeds reserved capacity' USING ERRCODE = 'LL002';
      END IF;
    END IF;
  ELSIF NEW.kind::text = 'COMPENSATION' THEN
    SELECT
      coalesce(sum(l.amount_minor) FILTER (
        WHERE l.kind::text = 'CONSUMPTION' AND e.transaction_id = related_transaction
      ), 0),
      coalesce(sum(l.amount_minor) FILTER (
        WHERE l.kind::text = 'COMPENSATION' AND e.transaction_id = linked_transaction
      ), 0)
      INTO source_allocation, compensated_amount
      FROM credit_grant_entries l
      JOIN entries e ON e.id = l.entry_id AND e.tenant_id = l.tenant_id
      WHERE l.tenant_id = NEW.tenant_id AND l.grant_id = NEW.grant_id;
    IF linked_signed_amount >= 0 OR linked_relation <> 'REVERSAL'
      OR related_transaction IS NULL OR source_allocation = 0
      OR compensated_amount + NEW.amount_minor > source_allocation THEN
      RAISE EXCEPTION 'credit grant compensation does not match original allocation';
    END IF;
  ELSIF NEW.kind::text = 'EXPIRATION' THEN
    SELECT coalesce(sum(-signed_amount_minor), 0) INTO funding_credit
      FROM entries
      WHERE tenant_id = NEW.tenant_id AND transaction_id = linked_transaction
        AND account_id = funding_account AND signed_amount_minor < 0;
    IF grant_expiration IS NULL OR grant_expiration > linked_effective_at
      OR grant_expiration > transaction_timestamp() OR linked_signed_amount <= 0
      OR NEW.amount_minor <> entry_amount OR NEW.amount_minor > available_amount - reserved_amount
      OR funding_credit <> NEW.amount_minor THEN
      RAISE EXCEPTION 'credit grant expiration link is invalid';
    END IF;
  ELSIF NEW.kind::text = 'REFUND' THEN
    SELECT coalesce(sum(-signed_amount_minor), 0) INTO funding_credit
      FROM entries
      WHERE tenant_id = NEW.tenant_id AND transaction_id = linked_transaction
        AND account_id = funding_account AND signed_amount_minor < 0;
    IF linked_hold IS NOT NULL OR linked_relation IS NOT NULL OR related_transaction IS NOT NULL
      OR linked_signed_amount <= 0 OR NEW.amount_minor <> entry_amount
      OR NEW.amount_minor > available_amount - reserved_amount
      OR (grant_expiration IS NOT NULL AND (
        grant_expiration <= linked_effective_at OR grant_expiration <= transaction_timestamp()
      )) OR funding_credit <> NEW.amount_minor THEN
      RAISE EXCEPTION 'credit grant refund link is invalid';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.validate_credit_grant_hold_allocation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE grant_expiration timestamptz;
DECLARE capacity bigint;
DECLARE reserved bigint;
DECLARE held_amount bigint;
DECLARE held_state hold_state;
BEGIN
  SELECT expires_at INTO grant_expiration
    FROM credit_grants
    WHERE tenant_id = NEW.tenant_id AND ledger_id = NEW.ledger_id
      AND account_id = NEW.account_id AND id = NEW.grant_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid tenant-scoped allocation relationship' USING ERRCODE = 'LL003';
  END IF;
  SELECT he.signed_amount_minor, h.state INTO held_amount, held_state
    FROM hold_entries he
    JOIN holds h ON h.tenant_id = he.tenant_id AND h.id = he.hold_id
    WHERE he.tenant_id = NEW.tenant_id AND he.account_id = NEW.account_id
      AND he.id = NEW.hold_entry_id AND h.ledger_id = NEW.ledger_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid tenant-scoped allocation relationship' USING ERRCODE = 'LL003';
  END IF;
  IF held_amount IS NULL OR held_amount <= 0 OR held_state <> 'HELD'
    OR (grant_expiration IS NOT NULL AND grant_expiration <= transaction_timestamp()) THEN
    RAISE EXCEPTION 'credit grant hold allocation scope is invalid';
  END IF;
  SELECT remaining_minor INTO capacity
    FROM credit_grant_capacity_versions
    WHERE tenant_id = NEW.tenant_id AND grant_id = NEW.grant_id
    ORDER BY version DESC LIMIT 1;
  SELECT active_credit_grant_reservation(NEW.tenant_id, NEW.grant_id) INTO reserved;
  IF coalesce(capacity, 0) - reserved < NEW.amount_minor THEN
    RAISE EXCEPTION 'credit grant hold allocation exceeds eligible capacity';
  END IF;
  RETURN NEW;
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;
--> statement-breakpoint
COMMENT ON COLUMN public.accounts.balance_minor IS 'Posted signed balance: DEBIT entries are positive and CREDIT entries are negative.';
--> statement-breakpoint
COMMENT ON COLUMN public.accounts.reserved_delta_minor IS 'Signed pending delta that consumes natural balance; excludes capacity-increasing hold legs.';
--> statement-breakpoint
COMMENT ON COLUMN public.balance_snapshots.posted_minor IS 'Immutable account posted balance at the event boundary.';
--> statement-breakpoint
COMMENT ON COLUMN public.balance_snapshots.reserved_delta_minor IS 'Immutable account reservation delta at the event boundary.';
--> statement-breakpoint
COMMENT ON COLUMN public.entries.signed_amount_minor IS 'Signed entry amount: positive is DEBIT and negative is CREDIT.';
--> statement-breakpoint
COMMENT ON COLUMN public.hold_entries.signed_amount_minor IS 'Signed held entry amount: positive is DEBIT and negative is CREDIT.';
--> statement-breakpoint
COMMENT ON COLUMN public.holds.original_amount_minor IS 'Positive debit-side magnitude used to scale partial commits.';
--> statement-breakpoint
COMMENT ON COLUMN public.holds.remaining_amount_minor IS 'Uncommitted portion of original_amount_minor; zero after full commit or void.';
--> statement-breakpoint
CREATE TRIGGER a_hold_lifecycle_guard BEFORE INSERT OR DELETE OR UPDATE ON public.holds FOR EACH ROW EXECUTE FUNCTION public.guard_hold_lifecycle();
--> statement-breakpoint
CREATE TRIGGER account_grant_capability_immutable BEFORE UPDATE OF grant_enabled ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.reject_grant_capability_change();
--> statement-breakpoint
CREATE TRIGGER accounts_asset_history_guard BEFORE UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.account_asset_history_guard();
--> statement-breakpoint
CREATE TRIGGER allocated_hold_entries_immutable BEFORE DELETE OR UPDATE ON public.hold_entries FOR EACH ROW EXECUTE FUNCTION public.protect_allocated_hold_entry();
--> statement-breakpoint
CREATE TRIGGER assets_identity_guard BEFORE UPDATE ON public.assets FOR EACH ROW EXECUTE FUNCTION public.asset_identity_guard();
--> statement-breakpoint
CREATE TRIGGER credit_grant_allocation_reservation_appended AFTER INSERT ON public.credit_grant_hold_allocations FOR EACH ROW EXECUTE FUNCTION public.append_grant_allocation_reservation();
--> statement-breakpoint
CREATE TRIGGER credit_grant_capacity_baseline_guard BEFORE INSERT ON public.credit_grant_capacity_versions FOR EACH ROW EXECUTE FUNCTION public.reject_credit_grant_capacity_baseline_insert();
--> statement-breakpoint
CREATE TRIGGER credit_grant_capacity_version_appended AFTER INSERT ON public.credit_grant_entries FOR EACH ROW EXECUTE FUNCTION public.append_credit_grant_capacity_version();
--> statement-breakpoint
CREATE TRIGGER credit_grant_capacity_versions_immutable BEFORE DELETE OR UPDATE ON public.credit_grant_capacity_versions FOR EACH ROW EXECUTE FUNCTION public.reject_credit_grant_mutation();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_grant_compensation_complete AFTER INSERT ON public.credit_grant_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_grant_compensation_complete();
--> statement-breakpoint
CREATE TRIGGER credit_grant_entries_history_immutable BEFORE DELETE OR UPDATE ON public.entries FOR EACH ROW EXECUTE FUNCTION public.protect_credit_grant_history();
--> statement-breakpoint
CREATE TRIGGER credit_grant_entries_immutable BEFORE DELETE OR UPDATE ON public.credit_grant_entries FOR EACH ROW EXECUTE FUNCTION public.reject_credit_grant_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_grant_entries_validate BEFORE INSERT ON public.credit_grant_entries FOR EACH ROW EXECUTE FUNCTION public.validate_credit_grant_entry();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER credit_grant_hold_allocation_total AFTER INSERT ON public.credit_grant_hold_allocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_grant_allocation_total();
--> statement-breakpoint
CREATE TRIGGER credit_grant_hold_allocations_immutable BEFORE DELETE OR UPDATE ON public.credit_grant_hold_allocations FOR EACH ROW EXECUTE FUNCTION public.reject_credit_grant_hold_allocation_change();
--> statement-breakpoint
CREATE TRIGGER credit_grant_hold_allocations_valid BEFORE INSERT ON public.credit_grant_hold_allocations FOR EACH ROW EXECUTE FUNCTION public.validate_credit_grant_hold_allocation();
--> statement-breakpoint
CREATE TRIGGER credit_grant_transactions_immutable BEFORE DELETE OR UPDATE ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.protect_credit_grant_history();
--> statement-breakpoint
CREATE TRIGGER credit_grants_immutable BEFORE DELETE OR UPDATE ON public.credit_grants FOR EACH ROW EXECUTE FUNCTION public.reject_credit_grant_mutation();
--> statement-breakpoint
CREATE TRIGGER credit_grants_require_enabled_account BEFORE INSERT ON public.credit_grants FOR EACH ROW EXECUTE FUNCTION public.require_grant_enabled_account();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER expired_grant_capacity_removed AFTER INSERT ON public.credit_grant_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_expired_grant_capacity_removed();
--> statement-breakpoint
CREATE TRIGGER expiring_grant_enabled_funding_guard BEFORE INSERT ON public.credit_grants FOR EACH ROW EXECUTE FUNCTION public.reject_expiring_grant_enabled_funding();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER grant_account_holds_allocated AFTER INSERT OR UPDATE ON public.hold_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_grant_hold_allocated();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER grant_entries_attributed AFTER INSERT ON public.entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_grant_entry_attributed();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER grant_hold_amounts_consistent AFTER INSERT OR UPDATE ON public.holds DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_grant_hold_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER grant_hold_entries_consistent AFTER INSERT ON public.hold_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_grant_hold_consistency();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER grant_hold_postings_consistent AFTER INSERT ON public.entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.check_grant_hold_consistency();
--> statement-breakpoint
CREATE TRIGGER grant_hold_reservations_released BEFORE UPDATE ON public.holds FOR EACH ROW EXECUTE FUNCTION public.release_grant_hold_reservations();
--> statement-breakpoint
CREATE TRIGGER transaction_metadata_immutable BEFORE UPDATE OF metadata ON public.transactions FOR EACH ROW EXECUTE FUNCTION public.protect_transaction_metadata();
--> statement-breakpoint
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY accounts_tenant_rls ON public.accounts USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.assets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY assets_tenant_rls ON public.assets USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.credit_grant_capacity_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credit_grant_capacity_versions_tenant_rls ON public.credit_grant_capacity_versions USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.credit_grant_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credit_grant_entries_tenant_rls ON public.credit_grant_entries USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.credit_grant_hold_allocations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credit_grant_hold_allocations_tenant_rls ON public.credit_grant_hold_allocations USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.credit_grants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY credit_grants_tenant_rls ON public.credit_grants USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY entries_tenant_rls ON public.entries USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.hold_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY hold_entries_tenant_rls ON public.hold_entries USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.holds ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY holds_tenant_rls ON public.holds USING ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid)) WITH CHECK ((tenant_id = (current_setting('app.tenant_id'::text, true))::uuid));
--> statement-breakpoint
ALTER TABLE public.ledgers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY ledgers_tenant_rls ON public.ledgers USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));
--> statement-breakpoint
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY transactions_tenant_rls ON public.transactions USING (((tenant_id)::text = current_setting('app.tenant_id'::text, true))) WITH CHECK (((tenant_id)::text = current_setting('app.tenant_id'::text, true)));


--
-- PostgreSQL database dump complete
--
--> statement-breakpoint
ALTER TABLE ONLY public.assets FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.credit_grant_capacity_versions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.credit_grant_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.credit_grant_hold_allocations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.credit_grants FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.hold_entries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE ONLY public.holds FORCE ROW LEVEL SECURITY;
