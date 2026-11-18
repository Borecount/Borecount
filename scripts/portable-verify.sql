BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL session_replication_role = origin;

-- Use the deployed overlay role where available. The fallback probes the baseline
-- policies with a transaction-local, non-owner role and rolls its grants back.
DO $$
DECLARE
  probe_role text := 'borecount_runtime';
  overlay boolean := to_regnamespace('borecount_security') IS NOT NULL;
  relation text;
  tenant uuid;
  tenant_column text;
  expected bigint;
  visible bigint;
  baseline text[] := ARRAY[
    'accounts', 'assets', 'credit_grant_capacity_versions', 'credit_grant_entries',
    'credit_grant_hold_allocations', 'credit_grants', 'entries', 'hold_entries',
    'holds', 'ledgers', 'transactions'
  ];
BEGIN
  IF overlay THEN
    baseline := baseline || ARRAY['api_keys', 'balance_snapshots', 'recon_uploads',
      'recon_records', 'recon_rules', 'recon_runs', 'recon_results', 'tenants'];
  ELSE
    probe_role := 'borecount_restore_probe';
    CREATE ROLE borecount_restore_probe NOLOGIN NOBYPASSRLS;
    GRANT USAGE ON SCHEMA public TO borecount_restore_probe;
  END IF;
  SELECT id INTO tenant FROM tenants ORDER BY id LIMIT 1;

  FOREACH relation IN ARRAY baseline LOOP
    IF NOT overlay THEN
      EXECUTE format('GRANT SELECT ON public.%I TO %I', relation, probe_role);
    END IF;
    tenant_column := CASE WHEN relation = 'tenants' THEN 'id' ELSE 'tenant_id' END;
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I = $1', relation, tenant_column)
      INTO expected USING tenant;
    EXECUTE format('SET LOCAL ROLE %I', probe_role);
    IF NOT row_security_active(format('public.%I', relation)::regclass) THEN
      RAISE EXCEPTION 'tenant RLS inactive';
    END IF;
    -- Some baseline policies cast the tenant GUC directly to UUID.
    PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true);
    EXECUTE format('SELECT count(*) FROM public.%I WHERE %I <> $1', relation, tenant_column)
      INTO visible USING '00000000-0000-0000-0000-000000000000'::uuid;
    IF visible <> 0 THEN
      RAISE EXCEPTION 'foreign tenant visible';
    END IF;
    IF tenant IS NOT NULL THEN
      PERFORM set_config('app.tenant_id', tenant::text, true);
      EXECUTE format('SELECT count(*) FROM public.%I', relation) INTO visible;
      IF visible <> expected THEN
        RAISE EXCEPTION 'tenant row count differs';
      END IF;
      EXECUTE format('SELECT count(*) FROM public.%I WHERE %I <> $1', relation, tenant_column)
        INTO visible USING tenant;
      IF visible <> 0 THEN
        RAISE EXCEPTION 'foreign tenant visible';
      END IF;
    END IF;
    RESET ROLE;
  END LOOP;
END $$;

DO $$
DECLARE
  trigger_name text;
  relation text;
  sample tid;
BEGIN
  FOR relation, trigger_name IN VALUES
    ('transactions', 'transaction_metadata_immutable'),
    ('transactions', 'credit_grant_transactions_immutable'),
    ('entries', 'credit_grant_entries_history_immutable'),
    ('hold_entries', 'allocated_hold_entries_immutable'),
    ('credit_grants', 'credit_grants_immutable'),
    ('credit_grant_entries', 'credit_grant_entries_immutable'),
    ('credit_grant_capacity_versions', 'credit_grant_capacity_versions_immutable'),
    ('credit_grant_hold_allocations', 'credit_grant_hold_allocations_immutable')
  LOOP
    IF NOT EXISTS (SELECT FROM pg_trigger
      WHERE tgrelid = format('public.%I', relation)::regclass
        AND tgname = trigger_name AND tgenabled IN ('O', 'A')) THEN
      RAISE EXCEPTION 'immutable-history trigger inactive';
    END IF;
  END LOOP;

  SELECT ctid INTO sample FROM transactions ORDER BY id LIMIT 1;
  IF sample IS NOT NULL THEN
    BEGIN
      UPDATE transactions SET metadata = CASE WHEN metadata IS NULL THEN '{}'::jsonb END
        WHERE ctid = sample;
      RAISE EXCEPTION 'transaction metadata update succeeded';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'transaction metadata is immutable' THEN
        RAISE;
      END IF;
    END;
  END IF;

  FOREACH relation IN ARRAY ARRAY['credit_grants', 'credit_grant_entries', 'credit_grant_capacity_versions'] LOOP
    EXECUTE format('SELECT ctid FROM public.%I LIMIT 1', relation) INTO sample;
    IF sample IS NOT NULL THEN
      BEGIN
        EXECUTE format('UPDATE public.%I SET tenant_id = tenant_id WHERE ctid = $1', relation) USING sample;
        RAISE EXCEPTION 'credit grant history update succeeded';
      EXCEPTION WHEN raise_exception THEN
        IF SQLERRM <> 'credit grant history is immutable' THEN
          RAISE;
        END IF;
      END;
    END IF;
  END LOOP;
END $$;
ROLLBACK;
