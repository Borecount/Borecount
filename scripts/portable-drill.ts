import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;
const root = join(import.meta.dir, '..');
const admin = 'recovery_admin';
const port = '55435';
const sourceDb = 'drill_source';
const targetDb = 'drill_recovery';

function run(command: string[], env: Env, expected?: string) {
  const result = Bun.spawnSync(command, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  const stdout = result.stdout.toString().trim();
  if (expected) {
    if (result.exitCode === 0 || !result.stderr.toString().includes(expected)) {
      throw new Error(`Expected rejection: ${expected}`);
    }
    console.log(`Rejected as expected: ${expected}`);
  } else if (result.exitCode !== 0) {
    throw new Error(`${command[0]} failed during the synthetic drill`);
  }
  return stdout;
}

const sql = (env: Env, statement: string) =>
  run(['psql', '-XqAtw', '-v', 'ON_ERROR_STOP=1', '-c', statement], env);

const portable = (...args: string[]) => [
  process.execPath,
  'run',
  'scripts/portable-backup.ts',
  ...args,
];

async function interruptRestore(command: string[], env: Env) {
  const restore = spawn(command[0], command.slice(1), {
    cwd: root,
    env,
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  restore.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = once(restore, 'close');
  const pid = restore.pid;
  if (!pid) {
    await closed;
    throw new Error('could not start interrupted restore');
  }
  let interrupted = false;
  try {
    const deadline = performance.now() + 20_000;
    // Observe the live COPY before signalling the Bun process and PostgreSQL client.
    while (restore.exitCode === null && performance.now() < deadline) {
      if (
        sql(
          env,
          `
SELECT EXISTS (SELECT FROM pg_stat_progress_copy
               WHERE datname = current_database() AND command = 'COPY FROM')
`,
        ) === 't'
      ) {
        process.kill(-pid, 'SIGTERM');
        const [code] = await closed;
        if (code === 0 || !stderr.includes('Interrupted.'))
          throw new Error('restore did not report interruption');
        interrupted = true;
        break;
      }
      await Bun.sleep(10);
    }
    if (!interrupted) throw new Error('could not interrupt restore during COPY');
  } finally {
    if (restore.exitCode === null && restore.signalCode === null) {
      process.kill(-pid, 'SIGKILL');
      await closed;
    }
  }
  const deadline = performance.now() + 10_000;
  while (
    sql(env, "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'pg_restore'") !== '0'
  ) {
    if (performance.now() > deadline) throw new Error('interrupted restore session did not exit');
    await Bun.sleep(50);
  }
}

async function drill(scratch: string, source: Env, target: Env) {
  const service = join(scratch, 'service');
  writeFileSync(
    service,
    `[drill]\nhost=${source.PGHOST}\nport=${port}\ndbname=${sourceDb}\nuser=${admin}\n`,
  );
  const backupEnv = { ...source, PGSERVICEFILE: service };
  const bundle = join(scratch, 'bundle');
  const migrations = join(scratch, 'host-migrations');
  mkdirSync(join(migrations, 'meta'), { recursive: true });
  const journalPath = join(migrations, 'meta/_journal.json');
  const packageJournal = JSON.parse(readFileSync(join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  const journal = { ...packageJournal, entries: [] as typeof packageJournal.entries };
  const hostTag = '0000_drill_host_data';
  const hostSql = join(migrations, `${hostTag}.sql`);
  writeFileSync(
    hostSql,
    'CREATE UNLOGGED TABLE public.drill_host_data (id int PRIMARY KEY, payload text);',
  );
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: packageJournal.entries.at(-1).when + 1000,
    tag: hostTag,
    breakpoints: true,
  });
  const saveJournal = () => writeFileSync(journalPath, JSON.stringify(journal));
  saveJournal();
  const migrationArgs = ['--host-migrations', migrations];
  const targetArgs = [
    '--socket',
    target.PGHOST as string,
    '--port',
    port,
    '--database',
    targetDb,
    '--user',
    admin,
  ];
  const recovery = (command: string, path = bundle, expected?: string) =>
    run(portable(command, ...migrationArgs, ...targetArgs, path), target, expected);

  run(['bun', 'run', 'db:migrate'], source);
  run(
    ['psql', '-Xqw', '-v', 'ON_ERROR_STOP=1', '-1', '-f', 'examples/security/least-privilege.sql'],
    source,
  );
  run(['bun', 'run', 'scripts/portable-drill-fixture.ts', 'seed'], source);
  const config = join(scratch, 'drizzle.config.ts');
  writeFileSync(
    config,
    `export default { dialect: 'postgresql', out: ${JSON.stringify(migrations)}, migrations: { schema: 'host_migrations', table: '__drizzle_migrations' }, dbCredentials: { url: process.env.DATABASE_URL } };`,
  );
  sql(
    target,
    `
CREATE ROLE borecount_runtime;
CREATE ROLE borecount_operator;
CREATE ROLE borecount_authenticator;
CREATE ROLE borecount_credential_owner;
`,
  );
  const baselineBundle = join(scratch, 'baseline-bundle');
  run(
    portable('backup', '--source', 'drill', ...migrationArgs, join(scratch, 'absent-host-journal')),
    backupEnv,
    'host migration history requires both',
  );
  writeFileSync(journalPath, JSON.stringify({ ...journal, entries: [] }));
  run(['bunx', 'drizzle-kit', 'migrate', '--config', config], source);
  run(
    portable('backup', '--source', 'drill', join(scratch, 'empty-host-journal')),
    backupEnv,
    'host migration history requires both',
  );
  sql(source, 'DROP SCHEMA host_migrations CASCADE');
  saveJournal();
  run(portable('backup', '--source', 'drill', baselineBundle), backupEnv);
  run(portable('restore', ...targetArgs, baselineBundle), target);
  run(['dropdb', targetDb], target);
  run(['createdb', targetDb], target);
  console.log('Default package-only backup and restore passed.');
  // Recreate only this drill's database to model an older installed package release.
  run(['dropdb', sourceDb], source);
  run(['createdb', sourceDb], source);
  const baselineMigrations = join(scratch, 'package-baseline');
  cpSync(join(root, 'drizzle'), baselineMigrations, { recursive: true });
  writeFileSync(
    join(baselineMigrations, 'meta/_journal.json'),
    JSON.stringify({ ...packageJournal, entries: packageJournal.entries.slice(0, 1) }),
  );
  const baselineConfig = join(scratch, 'baseline.config.ts');
  writeFileSync(
    baselineConfig,
    `export default { dialect: 'postgresql', out: ${JSON.stringify(baselineMigrations)}, dbCredentials: { url: process.env.DATABASE_URL } };`,
  );
  run(['bunx', 'drizzle-kit', 'migrate', '--config', baselineConfig], source);
  run(['bunx', 'drizzle-kit', 'migrate', '--config', config], source);
  sql(source, "INSERT INTO public.drill_host_data VALUES (0, 'before package upgrade')");
  const hostHistorySql =
    'SELECT json_agg(row(hash, created_at) ORDER BY id)::text FROM host_migrations.__drizzle_migrations';
  const hostHistory = sql(source, hostHistorySql);
  run(['bun', 'run', 'db:migrate'], source);
  if (
    sql(source, 'SELECT count(*) FROM drizzle.__drizzle_migrations') !==
      String(packageJournal.entries.length) ||
    sql(
      source,
      "SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recon_runs' AND column_name = 'matching_rule_ids'",
    ) !== '1' ||
    sql(source, "SELECT to_regclass('public.recon_runs_ledger_history_idx') IS NOT NULL") !== 't' ||
    sql(source, 'SELECT payload FROM public.drill_host_data WHERE id = 0') !==
      'before package upgrade' ||
    sql(source, hostHistorySql) !== hostHistory
  )
    throw new Error('independent package upgrade did not preserve host history');
  const packageHistory = sql(
    source,
    'SELECT json_agg(row(hash, created_at) ORDER BY id)::text FROM drizzle.__drizzle_migrations',
  );
  run(['bun', 'run', 'db:migrate'], source);
  run(['bunx', 'drizzle-kit', 'migrate', '--config', config], source);
  if (
    sql(source, hostHistorySql) !== hostHistory ||
    sql(
      source,
      'SELECT json_agg(row(hash, created_at) ORDER BY id)::text FROM drizzle.__drizzle_migrations',
    ) !== packageHistory
  )
    throw new Error('migration rerun changed one of the independent journals');
  console.log(
    'Package upgrade after a later-dated host migration passed; both reruns were no-ops.',
  );
  run(
    ['psql', '-Xqw', '-v', 'ON_ERROR_STOP=1', '-1', '-f', 'examples/security/least-privilege.sql'],
    source,
  );
  run(['bun', 'run', 'scripts/portable-drill-fixture.ts', 'seed'], source);
  // Unlogged synthetic host rows give the interruption test time to observe COPY.
  sql(
    source,
    `
INSERT INTO public.drill_host_data
SELECT i, repeat(md5(i::text), 256) FROM generate_series(1, 12000) AS i;
`,
  );
  run(
    portable('backup', '--source', 'drill', join(scratch, 'missing-host-history')),
    backupEnv,
    'host migration history requires both',
  );
  const hostEntry = journal.entries[0];
  sql(source, "UPDATE host_migrations.__drizzle_migrations SET hash = 'changed-host-history'");
  run(
    portable('backup', '--source', 'drill', ...migrationArgs, join(scratch, 'wrong-host-history')),
    backupEnv,
    'database host migration history differs',
  );
  const originalHostHash = createHash('sha256').update(readFileSync(hostSql)).digest('hex');
  sql(source, `UPDATE host_migrations.__drizzle_migrations SET hash = '${originalHostHash}'`);
  console.log(run(portable('backup', '--source', 'drill', ...migrationArgs, bundle), backupEnv));
  run(
    portable('preflight', ...targetArgs, bundle),
    target,
    'incompatible package versions or Drizzle history',
  );
  const originalHostSql = readFileSync(hostSql, 'utf8');
  writeFileSync(hostSql, `${originalHostSql}\n-- changed host migration`);
  recovery('preflight', bundle, 'incompatible package versions or Drizzle history');
  writeFileSync(hostSql, originalHostSql);
  const hostWhen = hostEntry.when;
  hostEntry.when = 0;
  saveJournal();
  recovery('preflight', bundle, 'ordered timestamps');
  hostEntry.when = hostWhen;
  hostEntry.tag = '../outside';
  saveJournal();
  recovery('preflight', bundle, 'unique safe migration tags');
  hostEntry.tag = hostTag;
  saveJournal();

  run(
    portable(
      'preflight',
      ...migrationArgs,
      '--socket',
      source.PGHOST as string,
      '--port',
      port,
      '--database',
      sourceDb,
      '--user',
      admin,
      bundle,
    ),
    target,
    'source and target share a PostgreSQL cluster',
  );
  sql(target, 'CREATE DATABASE drill_unrelated');
  recovery('preflight', bundle, 'dedicated socket-only recovery cluster');
  sql(target, 'DROP DATABASE drill_unrelated');

  const incomplete = join(scratch, 'incomplete');
  mkdirSync(incomplete);
  recovery('preflight', incomplete, 'incomplete backup');
  const bad = join(scratch, 'bad');
  mkdirSync(bad);
  const archive = join(bad, 'database.dump');
  copyFileSync(join(bundle, 'database.dump'), archive);
  const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
  const metadata = join(bad, 'manifest.json');
  for (const [override, failure] of [
    [{ source: { ...manifest.source, server: 170000 } }, 'incompatible source server version'],
    [{ tools: { ...manifest.tools, pg_dump: '16.999' } }, 'incompatible PostgreSQL client version'],
    [
      { compatibility: { ...manifest.compatibility, packages: {} } },
      'incompatible package versions',
    ],
    [
      { compatibility: { ...manifest.compatibility, history: [] } },
      'incompatible package versions or Drizzle history',
    ],
    [{ checks: {} }, 'incomplete verification metadata'],
  ] as const) {
    writeFileSync(metadata, JSON.stringify({ ...manifest, ...override }));
    recovery('preflight', bad, failure);
  }
  writeFileSync(metadata, JSON.stringify(manifest));
  const bytes = readFileSync(archive);
  bytes[bytes.length - 1] ^= 1;
  writeFileSync(archive, bytes);
  recovery('restore', bad, 'archive checksum or size mismatch');

  sql(source, "UPDATE drizzle.__drizzle_migrations SET created_at = 1, hash = 'retired-chain'");
  const rejected = join(scratch, 'rejected');
  run(
    portable('backup', '--source', 'drill', ...migrationArgs, rejected),
    backupEnv,
    'database Drizzle history differs',
  );
  if (await Bun.file(join(rejected, 'manifest.json')).exists())
    throw new Error('incompatible backup published a bundle');
  sql(source, "INSERT INTO public.drill_host_data VALUES (12001, 'committed after the backup')");
  const staleLock = join(target.PGHOST as string, '.borecount-recovery.lock');
  mkdirSync(staleLock);
  recovery('restore', bundle, 'recovery lock in use');
  rmSync(staleLock, { recursive: true });
  console.log(recovery('preflight'));
  const started = performance.now();
  await interruptRestore(portable('restore', ...migrationArgs, ...targetArgs, bundle), target);
  console.log(recovery('preflight'));
  console.log('Interrupted COPY rolled back; target passed empty preflight.');
  console.log(recovery('restore'));
  recovery('restore', bundle, 'restore target is not empty');
  run(['bun', 'run', 'scripts/portable-drill-fixture.ts', 'replay'], target);
  console.log(recovery('verify'));
  if (sql(target, 'SELECT id FROM public.drill_host_data WHERE id IN (12000, 12001)') !== '12000') {
    throw new Error('recovery boundary fixture differs');
  }
  console.log('Recovered the pre-backup marker and excluded the later committed marker.');
  console.log(`Interruption, retry, restore and verified API replay: ${seconds(started)}s.`);
  sql(target, 'ALTER TABLE public.transactions DISABLE TRIGGER transaction_metadata_immutable');
  recovery('verify', bundle, 'restored schema, contents or ledger totals differ');
}

const seconds = (started: number) => ((performance.now() - started) / 1000).toFixed(2);

async function main() {
  const started = performance.now();
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PG')),
  );
  const scratch = realpathSync(mkdtempSync('/tmp/bc-drill-'));
  chmodSync(scratch, 0o700);
  const clusters: string[] = [];
  const environments: Env[] = [];
  try {
    for (const [database, name] of [
      [sourceDb, 'src'],
      [targetDb, 'dst'],
    ]) {
      const socket = join(scratch, name);
      mkdirSync(socket, { mode: 0o700 });
      const data = join(socket, 'data');
      run(['initdb', '-D', data, '-U', admin, '-A', 'trust', '--no-locale', '-E', 'UTF8'], base);
      clusters.push(data);
      run(
        [
          'pg_ctl',
          '-D',
          data,
          '-l',
          join(socket, 'server'),
          '-o',
          `-h '' -p ${port} -k ${socket}`,
          'start',
        ],
        base,
      );
      const env = {
        ...base,
        PGHOST: socket,
        PGPORT: port,
        PGUSER: admin,
        PGDATABASE: database,
        DATABASE_URL: `postgresql:///${database}`,
      };
      run(['createdb', database], env);
      environments.push(env);
    }
    await drill(scratch, environments[0], environments[1]);
  } finally {
    for (const data of clusters.reverse()) {
      Bun.spawnSync(['pg_ctl', '-D', data, '-m', 'fast', 'stop'], {
        env: base,
        stdout: 'ignore',
        stderr: 'ignore',
      });
    }
    rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`Full disposable drill elapsed: ${seconds(started)}s.`);
}

process.umask(0o077);
try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Synthetic drill failed.');
  process.exitCode = 1;
}
