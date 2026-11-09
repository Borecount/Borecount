#!/usr/bin/env python3
"""Run a synthetic recovery drill against two newly initialized private clusters."""

import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
ADMIN = "recovery_admin"
PORT = "55435"
SOURCE = "drill_source"
TARGET = "drill_recovery"


def run(*args, env=None, expected=None):
    result = subprocess.run(list(map(str, args)), cwd=ROOT, env=env, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if expected is not None:
        if result.returncode == 0 or expected not in result.stdout:
            raise RuntimeError(f"expected rejection: {expected}")
        print(f"Rejected as expected: {expected}", flush=True)
    elif result.returncode:
        raise RuntimeError(f"{args[0]} failed during the synthetic drill")
    return result.stdout.strip()


def sql(env, statement):
    return run("psql", "-XqAtw", "-v", "ON_ERROR_STOP=1", "-c", statement, env=env)


def portable(*args):
    return [sys.executable, ROOT / "scripts/portable-backup.py", *args]


def interrupt_restore(command, env):
    # Observe an in-flight COPY so termination happens inside pg_restore's transaction.
    with subprocess.Popen(command, cwd=ROOT, env=env, stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, start_new_session=True) as restore:
        try:
            deadline = time.monotonic() + 20
            while restore.poll() is None and time.monotonic() < deadline:
                if sql(env, """
SELECT EXISTS (SELECT FROM pg_stat_progress_copy
               WHERE datname = current_database() AND command = 'COPY FROM')
""") == "t":
                    os.killpg(restore.pid, signal.SIGTERM)
                    output, _ = restore.communicate(timeout=10)
                    if restore.returncode == 0 or "Interrupted." not in output:
                        raise RuntimeError("restore did not report interruption")
                    break
                time.sleep(0.01)
            else:
                raise RuntimeError("could not interrupt restore during COPY")
        finally:
            if restore.poll() is None:
                os.killpg(restore.pid, signal.SIGKILL)
    deadline = time.monotonic() + 10
    while sql(env, "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_restore'") != "0":
        if time.monotonic() > deadline:
            raise RuntimeError("interrupted restore session did not exit")
        time.sleep(0.05)


def drill(scratch, source, target):
    service_file = scratch / "service"
    service_file.write_text(f"[drill]\nhost={source['PGHOST']}\nport={PORT}\ndbname={SOURCE}\nuser={ADMIN}\n")
    backup_env = dict(source, PGSERVICEFILE=str(service_file))
    bundle = scratch / "bundle"
    source_args = ["--source", "drill", bundle]
    target_args = ["--socket", target["PGHOST"], "--port", PORT,
                   "--database", TARGET, "--user", ADMIN]
    run("bun", "run", "db:migrate", env=source)
    run("psql", "-Xqw", "-v", "ON_ERROR_STOP=1", "-1", "-f",
        "examples/security/least-privilege.sql", env=source)
    run("bun", "run", "scripts/portable-drill-fixture.ts", "seed", env=source)
    sql(target, """
CREATE ROLE borecount_runtime;
CREATE ROLE borecount_operator;
CREATE ROLE borecount_authenticator;
CREATE ROLE borecount_credential_owner;
""")
    # Unlogged synthetic host rows give the interruption test time to observe COPY.
    sql(source, """
CREATE UNLOGGED TABLE public.drill_host_data (id int PRIMARY KEY, payload text);
INSERT INTO public.drill_host_data
SELECT i, repeat(md5(i::text), 256) FROM generate_series(1, 12000) AS i;
""")
    print(run(*portable("backup", *source_args), env=backup_env), flush=True)

    source_target = ["--socket", source["PGHOST"], "--port", PORT,
                     "--database", SOURCE, "--user", ADMIN]
    run(*portable("preflight", *source_target, bundle), env=target,
        expected="source and target share a PostgreSQL cluster")
    sql(target, "CREATE DATABASE drill_unrelated")
    run(*portable("preflight", *target_args, bundle), env=target,
        expected="dedicated socket-only recovery cluster")
    sql(target, "DROP DATABASE drill_unrelated")

    incomplete = scratch / "incomplete"
    incomplete.mkdir()
    run(*portable("preflight", *target_args, incomplete), env=target, expected="incomplete backup")
    bad = scratch / "bad"
    shutil.copytree(bundle, bad)
    manifest_path = bad / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for key, value, failure in [
        ("source", dict(manifest["source"], server=170000), "incompatible source server version"),
        ("tools", dict(manifest["tools"], pg_dump="16.999"), "incompatible PostgreSQL client version"),
        ("compatibility", dict(manifest["compatibility"], packages={}), "incompatible package versions"),
        ("compatibility", dict(manifest["compatibility"], history=[]), "incompatible package versions or Drizzle history"),
    ]:
        manifest_path.write_text(json.dumps(dict(manifest, **{key: value})))
        run(*portable("preflight", *target_args, bad), env=target, expected=failure)
    manifest_path.write_text(json.dumps(dict(manifest, checks={})))
    run(*portable("preflight", *target_args, bad), env=target, expected="malformed metadata")
    manifest_path.write_text(json.dumps(manifest))
    with (bad / "database.dump").open("r+b") as archive:
        archive.seek(-1, os.SEEK_END)
        value = archive.read(1)[0]
        archive.seek(-1, os.SEEK_END)
        archive.write(bytes([value ^ 1]))
    run(*portable("restore", *target_args, bad), env=target, expected="archive checksum or size mismatch")

    # A distinct actual migration row must fail even when this checkout and schema match.
    sql(source, "UPDATE drizzle.__drizzle_migrations SET created_at = 1, hash = 'retired-chain'")
    run(*portable("backup", "--source", "drill", scratch / "rejected"), env=backup_env,
        expected="database Drizzle history differs")
    if (scratch / "rejected").exists():
        raise RuntimeError("incompatible backup published a bundle")
    sql(source, "INSERT INTO public.drill_host_data VALUES (12001, 'committed after the backup')")
    print(run(*portable("preflight", *target_args, bundle), env=target), flush=True)
    recovery_started = time.monotonic()
    interrupt_restore(portable("restore", *target_args, bundle), target)
    print(run(*portable("preflight", *target_args, bundle), env=target), flush=True)
    print("Interrupted COPY rolled back; target passed empty preflight.", flush=True)
    print(run(*portable("restore", *target_args, bundle), env=target), flush=True)
    run(*portable("restore", *target_args, bundle), env=target, expected="restore target is not empty")
    run("bun", "run", "scripts/portable-drill-fixture.ts", "replay", env=target)
    print(run(*portable("verify", *target_args, bundle), env=target), flush=True)
    if sql(target, "SELECT id FROM public.drill_host_data WHERE id IN (12000, 12001)") != "12000":
        raise RuntimeError("recovery boundary fixture differs")
    print("Recovered the pre-backup marker and excluded the later committed marker.", flush=True)
    print(f"Interruption, retry, restore and verified API replay: {time.monotonic() - recovery_started:.2f}s.", flush=True)
    sql(target, "ALTER TABLE public.transactions DISABLE TRIGGER transaction_metadata_immutable")
    run(*portable("verify", *target_args, bundle), env=target, expected="restored schema, contents or ledger totals differ")


def main():
    started = time.monotonic()
    base = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    # Keep Unix socket paths short and independent of deployment configuration.
    with tempfile.TemporaryDirectory(prefix="bc-drill-", dir="/tmp") as path:
        scratch = Path(path).resolve()
        environments = []
        clusters = []
        try:
            for name in (SOURCE, TARGET):
                socket = scratch / ("src" if name == SOURCE else "dst")
                socket.mkdir(mode=0o700)
                data = socket / "data"
                run("initdb", "-D", data, "-U", ADMIN, "-A", "trust", "--no-locale", "-E", "UTF8", env=base)
                clusters.append(data)
                run("pg_ctl", "-D", data, "-l", socket / "server",
                    "-o", f"-h '' -p {PORT} -k {socket}", "start", env=base)
                env = dict(base, PGHOST=str(socket), PGPORT=PORT, PGUSER=ADMIN,
                           PGDATABASE=name, DATABASE_URL=f"postgresql:///{name}")
                run("createdb", name, env=env)
                environments.append(env)
            drill(scratch, *environments)
        finally:
            for data in reversed(clusters):
                subprocess.run(["pg_ctl", "-D", data, "-m", "fast", "stop"],
                               env=base, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"Full disposable drill elapsed: {time.monotonic() - started:.2f}s.")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        main()
    except RuntimeError as error:
        sys.exit(str(error))
