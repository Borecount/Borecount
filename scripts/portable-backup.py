#!/usr/bin/env python3
"""Portable Borecount logical backups for PostgreSQL 16."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
BASELINE = "0000_2026-11-09-baseline"
TOOLS = ("psql", "pg_dump", "pg_restore")
HISTORY = """
SELECT coalesce(json_agg(json_build_array(created_at, hash) ORDER BY created_at, id), '[]')
FROM drizzle.__drizzle_migrations
"""
IDENTITY = """
SELECT json_build_object(
  'system', system_identifier::text,
  'server', current_setting('server_version_num')::int,
  'locale', (SELECT json_build_array(pg_encoding_to_char(encoding), datlocprovider,
                                    datcollate, datctype, daticulocale, datcollversion)
             FROM pg_database WHERE datname = current_database()),
  'database', current_database()
) FROM pg_catalog.pg_control_system()
"""
SESSION = """
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL IntervalStyle TO 'postgres';
SET LOCAL extra_float_digits TO 3;
SET LOCAL bytea_output TO 'hex';
SET LOCAL row_security TO off;
SET LOCAL search_path TO pg_catalog;
"""
EMPTY = """
SELECT NOT EXISTS (
    SELECT FROM pg_depend WHERE objid >= 16384 AND deptype <> 'p'
    UNION ALL SELECT FROM pg_largeobject_metadata
    UNION ALL SELECT FROM pg_namespace WHERE oid >= 16384
    UNION ALL SELECT FROM pg_subscription WHERE subdbid = (
        SELECT oid FROM pg_database WHERE datname = current_database())
)
"""
TOTALS = """
SELECT jsonb_build_array(tenant_id, ledger_id, asset_id, count(*), sum(balance_minor),
                         sum(abs(balance_minor::numeric)), sum(reserved_delta_minor))
FROM public.accounts GROUP BY tenant_id, ledger_id, asset_id ORDER BY 1;
SELECT jsonb_build_array(e.tenant_id, t.ledger_id, e.asset_id, count(*),
                         sum(e.signed_amount_minor), sum(abs(e.signed_amount_minor::numeric)))
FROM public.entries e JOIN public.transactions t ON t.id = e.transaction_id
GROUP BY e.tenant_id, t.ledger_id, e.asset_id ORDER BY 1;
"""
TABLES = """
SELECT json_agg(format('%I.%I', n.nspname, c.relname)
                ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C")
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('information_schema', 'pg_catalog')
  AND n.nspname !~ '^pg_' AND NOT c.relispartition
"""
BALANCED = """
SELECT NOT EXISTS (
    SELECT FROM public.transactions t LEFT JOIN public.entries e ON e.transaction_id = t.id
    GROUP BY t.id HAVING count(e.id) < 2 OR sum(e.signed_amount_minor) <> 0
)
"""


class Rejected(Exception):
    """An operator-safe error with no database details."""


def require(condition, message):
    if not condition:
        raise Rejected(message)


def invoke(tool, *args, env=None, sql=None, output=subprocess.PIPE, failure=None, pass_fds=()):
    command = [tool, *map(str, args)]
    result = subprocess.run(
        command, env=env, input=sql, stdout=output, stderr=subprocess.DEVNULL, pass_fds=pass_fds, check=False
    )
    require(result.returncode == 0, failure or f"{tool} failed")
    return result.stdout


def psql_args():
    return ("-X", "-qAtw", "-v", "ON_ERROR_STOP=1")


def query(env, sql, failure=None, variables=()):
    return invoke("psql", *psql_args(), *variables, env=env, sql=sql.encode(),
                  failure=failure).decode().strip()


def digest(stream):
    return hashlib.file_digest(stream, "sha256").hexdigest()


def file_hash(path):
    with path.open("rb") as stream:
        return digest(stream)


def compatibility():
    migrations = ROOT / "drizzle"
    entries = json.loads((migrations / "meta/_journal.json").read_text())["entries"]
    require(entries and entries[0]["tag"] == BASELINE, "current squashed Drizzle baseline required")
    return {
        "history": [[entry["when"], file_hash(migrations / (entry["tag"] + ".sql"))]
                    for entry in entries],
        "packages": {
            data["name"]: data["version"]
            for path in sorted((ROOT / "packages").glob("*/package.json"))
            for data in [json.loads(path.read_text())]
        },
        "lock_sha256": file_hash(ROOT / "bun.lock"),
    }


def tool_versions():
    versions = {}
    for name in TOOLS:
        version = invoke(name, "--version").decode()
        match = re.search(r"\(PostgreSQL\) (16\.\d+)(?:\s|$)", version)
        require(match, f"{name} must be PostgreSQL 16")
        versions[name] = match[1]
    require(len(set(versions.values())) == 1, "PostgreSQL client tools must share a patch version")
    return versions


def db_env(**settings):
    keep = {"PGSERVICEFILE", "PGPASSFILE", "PGSYSCONFDIR"}
    env = {key: value for key, value in os.environ.items() if not key.startswith("PG") or key in keep}
    return dict(env, PGCONNECT_TIMEOUT="5", PGCLIENTENCODING="UTF8", **settings)


@contextmanager
def snapshot(env):
    """Keep the exporting transaction open while dump and probes import its snapshot."""
    with subprocess.Popen(
        ["psql", *psql_args()], env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL
    ) as session:
        try:
            session.stdin.write(b"""
SELECT clock_timestamp() AT TIME ZONE 'UTC';
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
SELECT clock_timestamp() AT TIME ZONE 'UTC';
""")
            session.stdin.flush()
            start, token, end = [session.stdout.readline().decode().strip() for _ in range(3)]
            require(re.fullmatch(r"[0-9A-Fa-f-]+", token), "could not export database snapshot")
            yield token, [start, end]
        finally:
            session.terminate()


def snapshot_sql(token, sql):
    return f"""
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '{token}';
{SESSION}
{sql};
COMMIT;
"""


def schema_fingerprint(env, token):
    with tempfile.TemporaryFile() as schema:
        invoke("pg_dump", "--no-password", "--schema-only", "--no-tablespaces",
               "--snapshot", token, env=env, output=schema)
        schema.seek(0)
        fingerprint = hashlib.sha256()
        for line in schema:
            if not line.startswith((b"-- Dumped ", b"\\restrict ", b"\\unrestrict ")):
                fingerprint.update(line)
        return fingerprint.hexdigest()


def evidence(env, token, expected):
    history = query(env, snapshot_sql(token, HISTORY), "Drizzle migration history is missing or unreadable")
    require(json.loads(history) == expected, "database Drizzle history differs from the squashed checkout")
    require(query(env, snapshot_sql(token, BALANCED)) == "t", "unbalanced or incomplete ledger transaction")
    totals = query(env, snapshot_sql(token, TOTALS))
    tables = json.loads(query(env, snapshot_sql(token, TABLES)))
    # JSONB canonicalizes key order. A C sort also handles tables without primary keys.
    copies = "\n".join(
        f"SELECT 'table {index}'; COPY (SELECT to_jsonb(t)::text FROM {table} t ORDER BY to_jsonb(t)::text COLLATE \"C\") TO STDOUT;"
        for index, table in enumerate(tables)
    )
    # Keep content private and stream hashes; never emit identifiers, balances or row data.
    with tempfile.TemporaryFile() as rows:
        invoke("psql", *psql_args(), env=env, sql=snapshot_sql(token, copies).encode(),
               output=rows, failure="could not fingerprint restored/backup table contents")
        rows.seek(0)
        contents = digest(rows)
    return {
        "schema_sha256": schema_fingerprint(env, token),
        "ledger_totals_sha256": hashlib.sha256(totals.encode()).hexdigest(),
        "tables_sha256": hashlib.sha256("\n".join(tables).encode()).hexdigest(),
        "table_count": len(tables),
        "rows_sha256": contents,
    }


def identity(env):
    value = json.loads(query(env, IDENTITY, "database identity requires pg_control_system access"))
    require(value["server"] // 10000 == 16, "database server must be PostgreSQL 16")
    require(value["locale"][0] == "UTF8", "database encoding must be UTF8")
    return value


def backup(args, local, tools):
    env = db_env(PGSERVICE=args.source)
    destination = args.bundle
    require(not destination.exists() and not destination.is_symlink(), "bundle path already exists")
    source = identity(env)
    require(int(tools["pg_dump"].split(".")[1]) >= source["server"] % 10000,
            "backup clients must be at least as recent as the source server")
    with tempfile.TemporaryDirectory(prefix=".incomplete-", dir=destination.parent) as scratch:
        staging = Path(scratch) / "bundle"
        staging.mkdir(mode=0o700)
        archive = staging / "database.dump"
        with snapshot(env) as (token, boundary):
            checks = evidence(env, token, local["history"])
            invoke("pg_dump", "--no-password", "--format=custom", "--no-tablespaces",
                   "--snapshot", token, "--file", archive, env=env)
        manifest = dict(
            format=1, source=source, tools=tools, compatibility=local, boundary_utc=boundary,
            archive={"bytes": archive.stat().st_size, "sha256": file_hash(archive)}, checks=checks,
        )
        (staging / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        for path in staging.iterdir():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
        sync_directory(staging)
        # Completed bundles are nonempty, so rename cannot overwrite another completed bundle.
        staging.rename(destination)
        sync_directory(destination.parent)
    print(f"Backup complete. Snapshot acquired between {boundary[0]} and {boundary[1]} UTC.")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def valid_sha(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value)


def read_bundle(bundle, local, tools):
    paths = [bundle / name for name in ("manifest.json", "database.dump")]
    require(all(path.is_file() and not path.is_symlink() for path in paths), "incomplete backup bundle")
    manifest = json.loads(paths[0].read_text())
    require(manifest["format"] == 1, "unsupported backup format")
    require(manifest["compatibility"] == local, "incompatible package versions or Drizzle history")
    source, archive, checks = (manifest[key] for key in ("source", "archive", "checks"))
    require(type(source["server"]) is int and source["server"] // 10000 == 16,
            "incompatible source server version")
    require(re.fullmatch(r"[0-9]+", source["system"]) and len(source["locale"]) == 6
            and source["locale"][0] == "UTF8" and isinstance(source["database"], str),
            "incomplete source identity")
    require(type(archive["bytes"]) is int and archive["bytes"] > 0 and valid_sha(archive["sha256"]),
            "incomplete archive metadata")
    require(type(checks["table_count"]) is int and checks["table_count"] > 0
            and all(valid_sha(checks[key]) for key in (
                "schema_sha256", "ledger_totals_sha256", "tables_sha256", "rows_sha256"
            )), "incomplete verification metadata")
    require(isinstance(manifest["boundary_utc"], list) and len(manifest["boundary_utc"]) == 2
            and all(isinstance(value, str) and value for value in manifest["boundary_utc"]),
            "incomplete snapshot boundary")
    require(set(manifest["tools"]) == set(TOOLS), "incomplete tool version metadata")
    for name, version in manifest["tools"].items():
        require(re.fullmatch(r"16\.\d+", version)
                and int(tools[name].split(".")[1]) >= int(version.split(".")[1]),
                "incompatible PostgreSQL client version")
    return manifest, paths[1]


def check_archive(manifest, archive):
    require(
        archive.stat().st_size > 0
        and archive.stat().st_size == manifest["archive"]["bytes"]
        and file_hash(archive) == manifest["archive"]["sha256"],
        "backup archive checksum or size mismatch",
    )
    invoke("pg_restore", "--list", archive, failure="invalid PostgreSQL custom archive")


def target_env(args):
    socket = args.socket.resolve(strict=True)
    require(socket.is_dir() and socket.stat().st_uid == os.getuid()
            and socket.stat().st_mode & 0o777 == 0o700, "restore socket directory must be owned and mode 0700")
    require(1 <= args.port <= 65535, "invalid target port")
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,62}", args.database)
            and args.database not in {"postgres", "template0", "template1"}, "use an explicit recovery database name")
    require(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,62}", args.user), "invalid target user")
    return socket, db_env(PGHOST=str(socket), PGPORT=str(args.port), PGDATABASE=args.database, PGUSER=args.user)


def check_target(env, manifest, tools, empty):
    target = identity(env)
    require(target["system"] != manifest["source"]["system"], "source and target share a PostgreSQL cluster")
    require(target["server"] >= manifest["source"]["server"], "target PostgreSQL patch predates the source")
    require(int(tools["pg_restore"].split(".")[1]) >= target["server"] % 10000,
            "restore clients must be at least as recent as the target server")
    require(target["locale"] == manifest["source"]["locale"], "target encoding or collation differs")
    require(query(env, """
SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
    AND current_setting('unix_socket_directories') = :'socket'
    AND current_setting('is_superuser') = 'on' AND NOT pg_is_in_recovery()
    AND NOT EXISTS (SELECT FROM pg_database WHERE NOT datistemplate
                    AND datname NOT IN ('postgres', current_database()))
    AND NOT EXISTS (SELECT FROM pg_prepared_xacts)
    AND NOT EXISTS (SELECT FROM pg_stat_activity
                    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid());
""", variables=("-v", f"socket={env['PGHOST']}")) == "t",
            "target must be a dedicated socket-only recovery cluster with no other clients")
    if empty:
        require(query(env, EMPTY) == "t", "restore target is not empty")


def verify(env, manifest, local):
    with snapshot(env) as (token, _):
        require(evidence(env, token, local["history"]) == manifest["checks"],
                "restored schema, contents or ledger totals differ from the backup snapshot")
    sql = Path(__file__).with_name("portable-verify.sql").read_bytes()
    invoke("psql", *psql_args(), env=env, sql=sql, failure="tenant isolation or immutability probe failed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("backup", "preflight", "restore", "verify"):
        sub = commands.add_parser(command)
        sub.add_argument("bundle", type=Path)
        if command == "backup":
            sub.add_argument("--source", required=True, help="source libpq service name")
        else:
            sub.add_argument("--socket", required=True, type=Path)
            sub.add_argument("--port", required=True, type=int)
            sub.add_argument("--database", required=True)
            sub.add_argument("--user", required=True)
    args = parser.parse_args()
    started = time.monotonic()
    local, tools = compatibility(), tool_versions()
    if args.command == "backup":
        backup(args, local, tools)
    else:
        manifest, archive = read_bundle(args.bundle, local, tools)
        socket, env = target_env(args)
        # Serialize this workflow across all recovery commands on the private socket.
        fd = os.open(socket / ".borecount-recovery.lock", os.O_CREAT | os.O_NOFOLLOW | os.O_RDWR, 0o600)
        with os.fdopen(fd, "rb") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            check_target(env, manifest, tools, empty=args.command != "verify")
            if args.command == "restore":
                # Restore the same private copy that was checked, even if the input changes.
                with tempfile.TemporaryDirectory() as scratch:
                    checked = Path(scratch) / "database.dump"
                    shutil.copyfile(archive, checked)
                    check_archive(manifest, checked)
                    check_target(env, manifest, tools, empty=True)
                    invoke("pg_restore", "--no-password", "--no-tablespaces", "--single-transaction", "--exit-on-error",
                           "--dbname", args.database, checked, env=env, pass_fds=(lock.fileno(),),
                           failure="atomic restore failed; check roles, extensions and target state")
            else:
                check_archive(manifest, archive)
            if args.command in {"restore", "verify"}:
                verify(env, manifest, local)
                print("SQL verification passed. Complete host/API checks before enabling access.")
    print(f"{args.command} elapsed: {time.monotonic() - started:.2f}s")


def interrupt(_signal, _frame):
    raise KeyboardInterrupt


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except Rejected as error:
        sys.exit(f"Rejected: {error}")
    except (OSError, ValueError, KeyError, TypeError, AttributeError, IndexError):
        sys.exit("Rejected: malformed metadata, filesystem error, missing tool or recovery lock in use")
    except KeyboardInterrupt:
        sys.exit("Interrupted. Keep the target offline and check its state before retrying.")
