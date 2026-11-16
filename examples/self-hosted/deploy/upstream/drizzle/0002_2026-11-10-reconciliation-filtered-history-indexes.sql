DROP INDEX "recon_runs_upload_idx";--> statement-breakpoint
CREATE INDEX "recon_runs_upload_history_idx" ON "recon_runs" USING btree ("upload_id","tenant_id","started_at","id");--> statement-breakpoint
CREATE INDEX "recon_runs_ledger_history_idx" ON "recon_runs" USING btree ("tenant_id","ledger_id","started_at","id");