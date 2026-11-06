-- Host deployment overlay for a dedicated Borecount database, applied AFTER migrations.
-- Run with psql -X --set ON_ERROR_STOP=1 --single-transaction --file ... as a trusted
-- installation superuser; runtime and migration logins remain separately controlled.
-- No passwords or LOGIN roles are created. See docs/integration/self-hosted-security.md.
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['borecount_runtime', 'borecount_authenticator',
    'borecount_credential_owner', 'borecount_operator'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS', role_name);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name AND
      (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication))
      OR EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = role_name)
    THEN RAISE EXCEPTION 'Unsafe existing security role: %', role_name; END IF;
  END LOOP;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC, borecount_runtime, borecount_authenticator, borecount_credential_owner, borecount_operator;
GRANT USAGE ON SCHEMA public TO borecount_runtime, borecount_credential_owner, borecount_operator;

-- Explicit table allowlist: new package/host tables receive no automatic grants.
DO $$
DECLARE table_name text;
DECLARE tenant_column text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenants', 'api_keys', 'assets', 'ledgers', 'accounts',
    'transactions', 'entries', 'holds', 'hold_entries', 'credit_grants',
    'credit_grant_entries', 'credit_grant_hold_allocations', 'credit_grant_capacity_versions',
    'balance_snapshots', 'recon_uploads', 'recon_records', 'recon_rules', 'recon_runs', 'recon_results'] LOOP
    IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner WHERE n.nspname = 'public'
      AND c.relname = table_name AND r.rolname IN ('borecount_runtime', 'borecount_authenticator', 'borecount_credential_owner'))
    THEN RAISE EXCEPTION 'Runtime/lookup role must not own table %', table_name; END IF;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, borecount_runtime, borecount_authenticator, borecount_credential_owner, borecount_operator', table_name);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    -- Restrictive policy also constrains preexisting permissive tenant policies.
    tenant_column := CASE WHEN table_name = 'tenants' THEN 'id' ELSE 'tenant_id' END;
    EXECUTE format('DROP POLICY IF EXISTS borecount_runtime_scope ON public.%I', table_name);
    EXECUTE format('CREATE POLICY borecount_runtime_scope ON public.%I AS RESTRICTIVE TO borecount_runtime USING (%I = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (%I = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', table_name, tenant_column, tenant_column);
    EXECUTE format('DROP POLICY IF EXISTS borecount_runtime_access ON public.%I', table_name);
    EXECUTE format('CREATE POLICY borecount_runtime_access ON public.%I TO borecount_runtime USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('DROP POLICY IF EXISTS borecount_operator_access ON public.%I', table_name);
    EXECUTE format('CREATE POLICY borecount_operator_access ON public.%I TO borecount_operator USING (true) WITH CHECK (true)', table_name);
    EXECUTE format('GRANT SELECT ON public.%I TO borecount_runtime', table_name);
    IF table_name <> 'tenants' THEN
      EXECUTE format('GRANT INSERT ON public.%I TO borecount_runtime', table_name);
    END IF;
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO borecount_operator', table_name);
  END LOOP;
END $$;

GRANT UPDATE (balance_minor, reserved_delta_minor, updated_at) ON accounts TO borecount_runtime;
GRANT UPDATE (state, remaining_amount_minor, applied_at, voided_at) ON holds TO borecount_runtime;
GRANT UPDATE (posted_minor) ON balance_snapshots TO borecount_runtime;
GRANT UPDATE (revoked_at) ON api_keys TO borecount_runtime;
-- SELECT FOR UPDATE needs UPDATE on at least one column. Metadata is immutable on
-- every transaction; IDs are only protected on grant-linked transactions.
REVOKE UPDATE (id) ON transactions FROM borecount_runtime;
GRANT UPDATE (metadata) ON transactions TO borecount_runtime;
GRANT UPDATE (id) ON credit_grants TO borecount_runtime;

GRANT SELECT ON api_keys TO borecount_credential_owner;
DROP POLICY IF EXISTS borecount_credential_lookup ON api_keys;
CREATE POLICY borecount_credential_lookup ON api_keys FOR SELECT TO borecount_credential_owner USING (true);

CREATE SCHEMA IF NOT EXISTS borecount_security;
REVOKE ALL ON SCHEMA borecount_security FROM PUBLIC, borecount_runtime, borecount_authenticator;
GRANT USAGE ON SCHEMA borecount_security TO borecount_authenticator, borecount_credential_owner;
-- CREATE is needed temporarily to transfer function ownership, never retained by the owner.
GRANT CREATE ON SCHEMA borecount_security TO borecount_credential_owner;
CREATE OR REPLACE FUNCTION borecount_security.find_active_api_key(requested_hash text)
RETURNS TABLE(id uuid, tenant_id uuid, name text, role text, key_hash text, created_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.name, k.role, k.key_hash, k.created_at, k.revoked_at
  FROM public.api_keys k WHERE k.key_hash = requested_hash AND k.revoked_at IS NULL LIMIT 1
$$;
CREATE OR REPLACE FUNCTION borecount_security.find_api_key(requested_id uuid)
RETURNS TABLE(id uuid, tenant_id uuid, name text, role text, key_hash text, created_at timestamptz, revoked_at timestamptz)
LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
  SELECT k.id, k.tenant_id, k.name, k.role, k.key_hash, k.created_at, k.revoked_at
  FROM public.api_keys k WHERE k.id = requested_id LIMIT 1
$$;
ALTER FUNCTION borecount_security.find_active_api_key(text) OWNER TO borecount_credential_owner;
ALTER FUNCTION borecount_security.find_api_key(uuid) OWNER TO borecount_credential_owner;
REVOKE CREATE ON SCHEMA borecount_security FROM borecount_credential_owner;
REVOKE ALL ON FUNCTION borecount_security.find_active_api_key(text), borecount_security.find_api_key(uuid)
  FROM PUBLIC, borecount_runtime, borecount_authenticator, borecount_operator;
GRANT EXECUTE ON FUNCTION borecount_security.find_active_api_key(text), borecount_security.find_api_key(uuid) TO borecount_authenticator;

-- Package routines only; host routines need their own reviewed grants.
DO $$
DECLARE routine record;
BEGIN
  FOR routine IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public'
    AND p.proname = ANY (ARRAY[
      'account_asset_history_guard', 'active_credit_grant_reservation', 'append_credit_grant_capacity_version',
      'append_credit_grant_reservation_version', 'append_grant_allocation_reservation', 'assert_expired_grant_capacity_removed',
      'assert_grant_allocation_total', 'assert_grant_compensation_complete', 'assert_grant_entry_attributed',
      'assert_grant_hold_allocated', 'assert_grant_hold_consistent', 'asset_identity_guard',
      'check_grant_hold_consistency', 'guard_hold_lifecycle', 'protect_allocated_hold_entry',
      'protect_credit_grant_history', 'protect_transaction_metadata', 'reject_credit_grant_capacity_baseline_insert',
      'reject_credit_grant_hold_allocation_change', 'reject_credit_grant_mutation', 'reject_expiring_grant_enabled_funding',
      'reject_grant_account_hold', 'reject_grant_capability_change', 'release_grant_hold_reservations',
      'require_grant_enabled_account', 'uuid_v7', 'validate_credit_grant_entry',
      'validate_credit_grant_hold_allocation']) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', routine.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO borecount_runtime, borecount_operator', routine.signature);
  END LOOP;
END $$;

-- Existing login memberships/ACLs are deployment state: reject unsafe composition,
-- rather than silently rewriting unrelated grants. Fresh roles pass before logins exist.
DO $$
DECLARE member_role record;
DECLARE protected_table record;
DECLARE allowed_updates text[];
BEGIN
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid
    WHERE r.rolname = 'borecount_credential_owner') THEN
    RAISE EXCEPTION 'Credential function owner must have no members';
  END IF;
  FOR member_role IN
    WITH RECURSIVE runtime_members AS (
      SELECT oid FROM pg_roles WHERE rolname = 'borecount_runtime'
      UNION SELECT m.member FROM pg_auth_members m JOIN runtime_members r ON m.roleid = r.oid
    ), reachable_roles AS (
      SELECT oid FROM runtime_members
      UNION SELECT m.roleid FROM pg_auth_members m JOIN reachable_roles r ON m.member = r.oid
    ) SELECT r.* FROM pg_roles r JOIN reachable_roles m USING (oid)
  LOOP
    IF member_role.rolsuper OR member_role.rolbypassrls OR member_role.rolcreaterole OR member_role.rolcreatedb OR member_role.rolreplication
      OR pg_has_role(member_role.oid, 'borecount_operator', 'MEMBER')
      OR pg_has_role(member_role.oid, 'borecount_authenticator', 'MEMBER')
      OR pg_has_role(member_role.oid, 'borecount_credential_owner', 'MEMBER')
      OR has_schema_privilege(member_role.oid, 'public', 'CREATE')
      OR has_schema_privilege(member_role.oid, 'borecount_security', 'CREATE')
      OR has_function_privilege(member_role.oid, 'borecount_security.find_active_api_key(text)', 'EXECUTE')
      OR has_function_privilege(member_role.oid, 'borecount_security.find_api_key(uuid)', 'EXECUTE')
    THEN RAISE EXCEPTION 'Unsafe runtime membership or schema grants: %', member_role.rolname; END IF;
    FOR protected_table IN
      SELECT c.oid, c.relowner, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_policy p ON p.polrelid = c.oid
      WHERE n.nspname = 'public' AND p.polname = 'borecount_runtime_scope'
    LOOP
      IF pg_has_role(member_role.oid, protected_table.relowner, 'MEMBER')
        OR has_table_privilege(member_role.oid, protected_table.oid, 'DELETE,TRUNCATE,TRIGGER,REFERENCES')
      THEN RAISE EXCEPTION 'Unsafe runtime ownership or table grants: %', member_role.rolname; END IF;
      allowed_updates := CASE protected_table.relname
        WHEN 'accounts' THEN ARRAY['balance_minor', 'reserved_delta_minor', 'updated_at']
        WHEN 'holds' THEN ARRAY['state', 'remaining_amount_minor', 'applied_at', 'voided_at']
        WHEN 'balance_snapshots' THEN ARRAY['posted_minor']
        WHEN 'api_keys' THEN ARRAY['revoked_at']
        WHEN 'transactions' THEN ARRAY['metadata']
        WHEN 'credit_grants' THEN ARRAY['id'] ELSE ARRAY[]::text[] END;
      IF EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = protected_table.oid
        AND a.attnum > 0 AND NOT a.attisdropped AND (
          (has_column_privilege(member_role.oid, a.attrelid, a.attnum, 'UPDATE')
            AND NOT a.attname = ANY (allowed_updates))
          OR has_column_privilege(member_role.oid, a.attrelid, a.attnum, 'REFERENCES')
          OR (protected_table.relname = 'tenants' AND has_column_privilege(member_role.oid, a.attrelid, a.attnum, 'INSERT'))
        )) THEN RAISE EXCEPTION 'Unsafe runtime column grants: % / %', member_role.rolname, protected_table.relname; END IF;
    END LOOP;
  END LOOP;
END $$;
