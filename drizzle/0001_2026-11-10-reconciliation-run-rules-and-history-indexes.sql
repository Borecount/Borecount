DROP INDEX "recon_records_upload_idx";--> statement-breakpoint
DROP INDEX "recon_runs_tenant_idx";--> statement-breakpoint
DROP INDEX "recon_uploads_tenant_idx";--> statement-breakpoint
ALTER TABLE "recon_runs" ADD COLUMN "matching_rule_ids" uuid[] NOT NULL;--> statement-breakpoint
CREATE INDEX "recon_records_history_idx" ON "recon_records" USING btree ("tenant_id","upload_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "recon_runs_history_idx" ON "recon_runs" USING btree ("tenant_id","started_at","id");--> statement-breakpoint
CREATE INDEX "recon_uploads_history_idx" ON "recon_uploads" USING btree ("tenant_id","created_at","id");