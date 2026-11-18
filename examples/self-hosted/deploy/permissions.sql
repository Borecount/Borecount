-- Apply as the offline installation administrator after package migrations.
\set ON_ERROR_STOP on
BEGIN;
\ir upstream/examples/security/least-privilege.sql
GRANT borecount_runtime TO ledger_app;
GRANT borecount_authenticator TO ledger_auth;
GRANT borecount_operator TO ledger_operator, ledger_migrator;
-- Repeat after mapping logins so the upstream membership/ACL audit includes them.
\ir upstream/examples/security/least-privilege.sql
GRANT USAGE ON SCHEMA drizzle TO borecount_runtime;
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO borecount_runtime;
COMMIT;
