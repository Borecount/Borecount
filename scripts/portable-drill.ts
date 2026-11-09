import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  copyFileSync,
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
    run(portable(command, ...targetArgs, path), target, expected);

  run(['bun', 'run', 'db:migrate'], source);
  run(
    ['psql', '-Xqw', '-v', 'ON_ERROR_STOP=1', '-1', '-f', 'examples/security/least-privilege.sql'],
    source,
  );
  run(['bun', 'run', 'scripts/portable-drill-fixture.ts', 'seed'], source);
  sql(
    target,
    `
CREATE ROLE borecount_runtime;
CREATE ROLE borecount_operator;
CREATE ROLE borecount_authenticator;
CREATE ROLE borecount_credential_owner;
`,
  );
  // Unlogged synthetic host rows give the interruption test time to observe COPY.
  sql(
    source,
    `
CREATE UNLOGGED TABLE public.drill_host_data (id int PRIMARY KEY, payload text);
INSERT INTO public.drill_host_data
SELECT i, repeat(md5(i::text), 256) FROM generate_series(1, 12000) AS i;
`,
  );
  console.log(run(portable('backup', '--source', 'drill', bundle), backupEnv));

  run(
    portable(
      'preflight',
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
    portable('backup', '--source', 'drill', rejected),
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
  await interruptRestore(portable('restore', ...targetArgs, bundle), target);
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
