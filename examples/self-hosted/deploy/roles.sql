\getenv migrator_password MIGRATOR_PASSWORD
\getenv app_password APP_PASSWORD
\getenv auth_password AUTH_PASSWORD
\getenv operator_password OPERATOR_PASSWORD
CREATE ROLE ledger_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'migrator_password';
CREATE ROLE ledger_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
CREATE ROLE ledger_auth LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'auth_password';
CREATE ROLE ledger_operator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'operator_password';
REVOKE ALL ON DATABASE borecount_self_hosted FROM PUBLIC;
GRANT CONNECT ON DATABASE borecount_self_hosted TO ledger_migrator, ledger_app, ledger_auth, ledger_operator;
GRANT CREATE ON DATABASE borecount_self_hosted TO ledger_migrator;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO ledger_migrator;
ALTER ROLE ledger_app SET statement_timeout = '15s';
ALTER ROLE ledger_app SET lock_timeout = '2s';
ALTER ROLE ledger_app SET idle_in_transaction_session_timeout = '15s';
ALTER ROLE ledger_auth SET statement_timeout = '5s';
ALTER ROLE ledger_auth SET lock_timeout = '2s';
ALTER ROLE ledger_operator SET statement_timeout = '60s';
ALTER ROLE ledger_operator SET lock_timeout = '5s';
