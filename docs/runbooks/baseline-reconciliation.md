# Baseline Reconciliation Runbook

Use baseline reconciliation to compare external provider records with posted Borecount transactions.

## Daily Workflow

1. Create or reuse a matching rule.

   Baseline reconciliation supports `one_to_one` matching. Start with deterministic criteria:

   - `reference` with `equals` or `contains`
   - `amount` with optional `amount_tolerance_minor`
   - `currency` with `equals`
   - `date` with optional `date_tolerance_seconds`

2. Ingest the provider records.

   Submit JSON records to `POST /v1/reconciliation/external-records`. Each record must include:

   - `id`: provider-side unique record id
   - `amount_minor`: positive integer string in minor units
   - `currency`
   - `reference`
   - `date`: ISO-8601 timestamp
   - optional `description` and `raw`

   Use a stable `source` value such as `stripe`, `bank-feed`, or `adyen`.

3. Run a dry-run first.

   Call `POST /v1/reconciliation/runs` with `dry_run: true`. A dry run returns a transient report.
   Save the response if you need it later. Its run ID cannot be retrieved through the run history
   or results endpoints. The original upload remains discoverable.
   When multiple `matching_rule_ids` are supplied, rules are evaluated as alternatives: a transaction matches if it fully satisfies any one rule.

4. Review statuses.

   - `matched`: one external record matched exactly one internal transaction.
   - `unmatched_external`: no internal transaction matched the external record.
   - `unmatched_internal`: an internal transaction was not successfully matched to an external record. A transaction can still appear here when it was only a mismatch/conflict candidate.
   - `mismatched`: reference matched, but another criterion failed.
   - `conflict`: multiple candidates matched; no arbitrary winner was selected.

5. Commit the run.

   Re-run with `dry_run: false` or omit `dry_run`. Save the returned run id for audit and follow-up.

6. Triage exceptions.

   Resolve `conflict` first because it blocks deterministic matching. Then investigate `mismatched`, followed by unmatched external/internal rows.

## Find prior work

- Use `GET /v1/reconciliation/uploads` to find uploads by `source` and `created_at`. Use `GET /v1/reconciliation/uploads/{id}` for metadata and `GET /v1/reconciliation/uploads/{id}/records` to inspect normalized records. Match result `external_record_id` to record `id`.
- Use `GET /v1/reconciliation/runs` to find persisted runs by `ledger_id`, `upload_id`, `status`, and `started_at`. Use `GET /v1/reconciliation/runs/{id}/results` to inspect result rows a page at a time.
- For paginated endpoints, send `limit` (default 50, maximum 200). Pass `next_cursor` as `cursor` on the next request with the same tenant, endpoint, parent ID, and filters. A null cursor marks the end of the list.

## Recover after a lost response

- **Ingestion.** List uploads for the source and submission window. Compare record counts and the provider IDs in the normalized record pages before reusing an upload. Ingestion is atomic. Repeating a batch with already-ingested record IDs for that source conflicts.
- **Persisted run.** List runs for the ledger, upload, and submission window. Compare candidates and inspect their result pages. Concurrent runs can have identical inputs, and a request can still be in flight when you first check. Retrying a persisted run can create a second report, so resolve ambiguous candidates before resubmitting.
- **Dry run.** Repeat the dry run to regenerate a report. If ledger transactions have changed, the new report may differ.

## Example Requests

Create a rule:

```json
{
  "name": "Bank feed baseline",
  "criteria": [
    { "field": "reference", "operator": "equals" },
    { "field": "amount", "operator": "equals", "amount_tolerance_minor": "0" },
    { "field": "currency", "operator": "equals" }
  ]
}
```

Ingest external records:

```json
{
  "source": "bank-feed",
  "records": [
    {
      "id": "bank-2026-01-01-0001",
      "amount_minor": "1000",
      "currency": "USD",
      "reference": "invoice-1001",
      "date": "2026-01-01T09:00:00.000Z"
    }
  ]
}
```

Run reconciliation:

```json
{
  "ledger_id": "018f0000-0000-7000-8000-000000000001",
  "upload_id": "018f0000-0000-7000-8000-000000000002",
  "strategy": "one_to_one",
  "matching_rule_ids": ["018f0000-0000-7000-8000-000000000003"],
  "dry_run": true
}
```

## Operating Rules

- Reconciliation never mutates ledger transactions.
- Committed runs persist immutable result rows for audit.
- Empty uploads are rejected before matching.
- Matching is deterministic: conflicts are reported explicitly instead of selecting a candidate by order.
- Multiple matching rules use OR semantics; criteria inside one rule use AND semantics.
- Re-uploading the same provider record id for the same source is rejected by `(tenant_id, source, external_id)` idempotency.
