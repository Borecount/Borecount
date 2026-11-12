import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { isDeepStrictEqual, parseArgs } from 'node:util';

const root = join(import.meta.dir, '..');
const baseline = '0000_2026-11-09-baseline';
const toolNames = ['psql', 'pg_dump', 'pg_restore'] as const;
const HISTORY = `
SELECT coalesce(json_agg(json_build_array(created_at, hash) ORDER BY created_at, id), '[]')
FROM drizzle.__drizzle_migrations
`;
const IDENTITY = `
SELECT json_build_object(
  'system', system_identifier::text,
  'server', current_setting('server_version_num')::int,
  'locale', (SELECT json_build_array(pg_encoding_to_char(encoding), datlocprovider,
                                    datcollate, datctype, daticulocale, datcollversion)
             FROM pg_database WHERE datname = current_database()),
  'database', current_database()
) FROM pg_catalog.pg_control_system()
`;
const SESSION = `
SET LOCAL TIME ZONE 'UTC';
SET LOCAL DateStyle TO 'ISO, YMD';
SET LOCAL IntervalStyle TO 'postgres';
SET LOCAL extra_float_digits TO 3;
SET LOCAL bytea_output TO 'hex';
SET LOCAL row_security TO off;
SET LOCAL search_path TO pg_catalog;
`;
const EMPTY = `
SELECT NOT EXISTS (
    SELECT FROM pg_depend WHERE objid >= 16384 AND deptype <> 'p'
    UNION ALL SELECT FROM pg_largeobject_metadata
    UNION ALL SELECT FROM pg_namespace WHERE oid >= 16384
    UNION ALL SELECT FROM pg_subscription WHERE subdbid = (
        SELECT oid FROM pg_database WHERE datname = current_database())
)
`;
const TOTALS = `
SELECT jsonb_build_array(tenant_id, ledger_id, asset_id, count(*), sum(balance_minor),
                         sum(abs(balance_minor::numeric)), sum(reserved_delta_minor))
FROM public.accounts GROUP BY tenant_id, ledger_id, asset_id ORDER BY 1;
SELECT jsonb_build_array(e.tenant_id, t.ledger_id, e.asset_id, count(*),
                         sum(e.signed_amount_minor), sum(abs(e.signed_amount_minor::numeric)))
FROM public.entries e JOIN public.transactions t ON t.id = e.transaction_id
GROUP BY e.tenant_id, t.ledger_id, e.asset_id ORDER BY 1;
`;
const TABLES = `
SELECT json_agg(format('%I.%I', n.nspname, c.relname)
                ORDER BY n.nspname COLLATE "C", c.relname COLLATE "C")
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r', 'p', 'm') AND n.nspname NOT IN ('information_schema', 'pg_catalog')
  AND n.nspname !~ '^pg_' AND NOT c.relispartition
`;
const BALANCED = `
SELECT NOT EXISTS (
    SELECT FROM public.transactions t LEFT JOIN public.entries e ON e.transaction_id = t.id
    GROUP BY t.id HAVING count(e.id) < 2 OR sum(e.signed_amount_minor) <> 0
)
`;

type Env = Record<string, string | undefined>;
type Versions = Record<(typeof toolNames)[number], string>;
type Identity = { system: string; server: number; locale: string[]; database: string };
type Compatibility = {
  history: [number, string][];
  host_history?: [number, string][];
  packages: Record<string, string>;
  lock_sha256: string;
};
type Checks = Record<
  'schema_sha256' | 'ledger_totals_sha256' | 'tables_sha256' | 'rows_sha256',
  string
> & { table_count: number };
type Manifest = {
  format: 1;
  source: Identity;
  tools: Versions;
  compatibility: Compatibility;
  boundary_utc: string[];
  archive: { bytes: number; sha256: string };
  checks: Checks;
};

class Rejected extends Error {}

function requireCheck(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Rejected(message);
}

const psql = ['psql', '-X', '-qAtw', '-v', 'ON_ERROR_STOP=1'];
const controller = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => controller.abort());
}

function spawn(command: string[], env?: Env, input?: string) {
  return Bun.spawn(command, {
    env,
    stdin: input === undefined ? 'ignore' : Buffer.from(input),
    stdout: 'pipe',
    stderr: 'ignore',
    signal: controller.signal,
  });
}

async function run(command: string[], env?: Env, input?: string, failure = `${command[0]} failed`) {
  const process = spawn(command, env, input);
  const output = await new Response(process.stdout).text();
  requireCheck((await process.exited) === 0, failure);
  return output.trim();
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const validSha = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function migrationInput<T>(path: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const reasons: Record<string, string> = {
      ENOENT: 'file not found',
      EACCES: 'permission denied',
      EPERM: 'permission denied',
      ENOTDIR: 'parent is not a directory',
      EISDIR: 'expected a file, found a directory',
    };
    const code = (error as NodeJS.ErrnoException)?.code ?? '';
    throw new Rejected(
      `cannot read migration file ${JSON.stringify(path)}: ${reasons[code] ?? 'filesystem error'}`,
    );
  }
}

async function migrationHistory(
  migrations: string,
  packageJournal = false,
): Promise<Compatibility['history']> {
  const journalPath = join(migrations, 'meta/_journal.json');
  const contents = await migrationInput(journalPath, () => readFile(journalPath, 'utf8'));
  let journal: unknown;
  try {
    journal = JSON.parse(contents);
  } catch {
    throw new Rejected(`invalid JSON in migration journal ${JSON.stringify(journalPath)}`);
  }
  requireCheck(
    typeof journal === 'object' &&
      journal !== null &&
      'dialect' in journal &&
      journal.dialect === 'postgresql' &&
      'entries' in journal &&
      Array.isArray(journal.entries),
    `invalid Drizzle journal structure in ${JSON.stringify(journalPath)}`,
  );
  const entries = journal.entries as { idx: number; when: number; tag: string }[];
  if (packageJournal)
    requireCheck(entries[0]?.tag === baseline, 'current squashed Drizzle baseline required');
  const tags = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    requireCheck(
      entry &&
        entry.idx === index &&
        Number.isSafeInteger(entry.when) &&
        entry.when > 0 &&
        (index === 0 || entry.when > entries[index - 1].when) &&
        typeof entry.tag === 'string' &&
        /^[A-Za-z0-9_-]+$/.test(entry.tag) &&
        !tags.has(entry.tag),
      `Drizzle journal requires ordered timestamps and unique safe migration tags: ${JSON.stringify(journalPath)}`,
    );
    tags.add(entry.tag);
  }
  return Promise.all(
    entries.map(async ({ when, tag }): Promise<[number, string]> => {
      const sqlPath = join(migrations, `${tag}.sql`);
      return [when, await migrationInput(sqlPath, () => fileHash(sqlPath))];
    }),
  );
}

async function compatibility(hostMigrations?: string): Promise<Compatibility> {
  const history = await migrationHistory(join(root, 'drizzle'), true);
  const hostHistory =
    hostMigrations === undefined ? undefined : await migrationHistory(resolve(hostMigrations));
  const packages = await Promise.all(
    (await readdir(join(root, 'packages'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map(async (name) => {
        const data = JSON.parse(
          await readFile(join(root, 'packages', name, 'package.json'), 'utf8'),
        );
        return [data.name, data.version];
      }),
  );
  return {
    history,
    ...(hostHistory === undefined ? {} : { host_history: hostHistory }),
    packages: Object.fromEntries(packages),
    lock_sha256: await fileHash(join(root, 'bun.lock')),
  };
}

async function toolVersions(): Promise<Versions> {
  const pairs = await Promise.all(
    toolNames.map(async (name) => {
      const match = /\(PostgreSQL\) (16\.\d+)(?:\s|$)/.exec(await run([name, '--version']));
      requireCheck(match, `${name} must be PostgreSQL 16`);
      return [name, match[1]] as const;
    }),
  );
  requireCheck(
    new Set(pairs.map(([, version]) => version)).size === 1,
    'PostgreSQL client tools must share a patch version',
  );
  return Object.fromEntries(pairs) as Versions;
}

function dbEnv(settings: Env): Env {
  const keep = new Set(['PGSERVICEFILE', 'PGPASSFILE', 'PGSYSCONFDIR']);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('PG') || keep.has(key)),
  );
  return { ...env, PGCONNECT_TIMEOUT: '5', PGCLIENTENCODING: 'UTF8', ...settings };
}

async function withSnapshot<T>(
  env: Env,
  action: (token: string, boundary: string[]) => Promise<T>,
) {
  const session = Bun.spawn(psql, {
    env,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
    signal: controller.signal,
  });
  const lines = createInterface({ input: Readable.from(session.stdout) });
  const rows = lines[Symbol.asyncIterator]();
  try {
    session.stdin.write(`
SELECT clock_timestamp() AT TIME ZONE 'UTC';
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT pg_export_snapshot();
SELECT clock_timestamp() AT TIME ZONE 'UTC';
`);
    session.stdin.flush();
    const start = (await rows.next()).value;
    const token = (await rows.next()).value;
    const end = (await rows.next()).value;
    requireCheck(
      typeof token === 'string' && /^[0-9A-Fa-f-]+$/.test(token) && start && end,
      'could not export database snapshot',
    );
    return await action(token, [start, end]);
  } finally {
    lines.close();
    session.kill();
    await session.exited;
  }
}

function snapshotSql(token: string, sql: string) {
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET TRANSACTION SNAPSHOT '${token}';
${SESSION}
${sql};
COMMIT;`;
}

async function schemaFingerprint(env: Env, token: string) {
  const process = spawn(
    ['pg_dump', '--no-password', '--schema-only', '--no-tablespaces', '--snapshot', token],
    env,
  );
  const hash = createHash('sha256');
  const lines = createInterface({ input: Readable.from(process.stdout) });
  for await (const line of lines) {
    if (!/^(-- Dumped |\\(?:un)?restrict )/.test(line)) hash.update(`${line}\n`);
  }
  requireCheck((await process.exited) === 0, 'could not fingerprint schema');
  return hash.digest('hex');
}

async function evidence(env: Env, token: string, expected: Compatibility): Promise<Checks> {
  const query = (sql: string, failure?: string) => run(psql, env, snapshotSql(token, sql), failure);
  const history = await query(HISTORY, 'Drizzle migration history is missing or unreadable');
  requireCheck(
    JSON.stringify(JSON.parse(history)) === JSON.stringify(expected.history),
    'database Drizzle history differs from the squashed checkout',
  );
  const hostHistoryExists =
    (await query("SELECT to_regclass('host_migrations.__drizzle_migrations') IS NOT NULL")) === 't';
  requireCheck(
    hostHistoryExists === (expected.host_history !== undefined),
    'host migration history requires both --host-migrations and host_migrations.__drizzle_migrations',
  );
  if (expected.host_history !== undefined) {
    const hostHistory = await query(
      HISTORY.replace('drizzle.__drizzle_migrations', 'host_migrations.__drizzle_migrations'),
      'host migration history is missing or unreadable',
    );
    requireCheck(
      JSON.stringify(JSON.parse(hostHistory)) === JSON.stringify(expected.host_history),
      'database host migration history differs from the selected host directory',
    );
  }
  requireCheck((await query(BALANCED)) === 't', 'unbalanced or incomplete ledger transaction');
  const totals = await query(TOTALS);
  const tables: string[] = JSON.parse(await query(TABLES));
  // Keep the row data private. JSONB canonicalizes key order and C ordering works without primary keys.
  const copies = tables
    .map(
      (table, index) => `
SELECT 'table ${index}';
COPY (SELECT to_jsonb(t)::text FROM ${table} t ORDER BY to_jsonb(t)::text COLLATE "C") TO STDOUT;
`,
    )
    .join('\n');
  const process = spawn(psql, env, snapshotSql(token, copies));
  const hash = createHash('sha256');
  for await (const chunk of process.stdout) hash.update(chunk);
  requireCheck((await process.exited) === 0, 'could not fingerprint table contents');
  return {
    schema_sha256: await schemaFingerprint(env, token),
    ledger_totals_sha256: sha256(totals),
    tables_sha256: sha256(tables.join('\n')),
    table_count: tables.length,
    rows_sha256: hash.digest('hex'),
  };
}

async function identity(env: Env): Promise<Identity> {
  const value: Identity = JSON.parse(
    await run(psql, env, IDENTITY, 'database identity requires pg_control_system access'),
  );
  requireCheck(Math.floor(value.server / 10000) === 16, 'database server must be PostgreSQL 16');
  requireCheck(value.locale[0] === 'UTF8', 'database encoding must be UTF8');
  return value;
}

const patch = (version: string) => Number(version.split('.')[1]);

async function sync(path: string) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function withScratch<T>(prefix: string, action: (scratch: string) => Promise<T>) {
  const scratch = await mkdtemp(prefix);
  try {
    return await action(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function backup(
  sourceName: string,
  destination: string,
  local: Compatibility,
  tools: Versions,
) {
  requireCheck(
    await lstat(destination).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
    ),
    'bundle path already exists or cannot be checked',
  );
  const env = dbEnv({ PGSERVICE: sourceName });
  const source = await identity(env);
  requireCheck(
    patch(tools.pg_dump) >= source.server % 10000,
    'backup clients must be at least as recent as the source server',
  );
  await withScratch(join(dirname(destination), '.incomplete-'), async (scratch) => {
    const staging = join(scratch, 'bundle');
    await mkdir(staging, { mode: 0o700 });
    const archive = join(staging, 'database.dump');
    const { checks, boundary } = await withSnapshot(env, async (token, boundary) => {
      const checks = await evidence(env, token, local);
      await run(
        [
          'pg_dump',
          '--no-password',
          '--format=custom',
          '--no-tablespaces',
          '--snapshot',
          token,
          '--file',
          archive,
        ],
        env,
      );
      return { checks, boundary };
    });
    const manifest: Manifest = {
      format: 1,
      source,
      tools,
      compatibility: local,
      boundary_utc: boundary,
      archive: { bytes: (await lstat(archive)).size, sha256: await fileHash(archive) },
      checks,
    };
    const metadata = join(staging, 'manifest.json');
    await writeFile(metadata, `${JSON.stringify(manifest, null, 2)}\n`);
    await Promise.all([sync(archive), sync(metadata)]);
    await sync(staging);
    await rename(staging, destination);
    await sync(dirname(destination));
    console.log(
      `Backup complete. Snapshot acquired between ${boundary[0]} and ${boundary[1]} UTC.`,
    );
  });
}

async function readBundle(bundle: string, local: Compatibility, tools: Versions) {
  const metadata = join(bundle, 'manifest.json');
  const archive = join(bundle, 'database.dump');
  for (const path of [metadata, archive]) {
    requireCheck(
      await lstat(path).then(
        (file) => file.isFile(),
        () => false,
      ),
      'incomplete backup bundle',
    );
  }
  const manifest: Manifest = JSON.parse(await readFile(metadata, 'utf8'));
  requireCheck(manifest.format === 1, 'unsupported backup format');
  requireCheck(
    isDeepStrictEqual(manifest.compatibility, local),
    'incompatible package versions or Drizzle history',
  );
  const { source, archive: details, checks } = manifest;
  requireCheck(
    Number.isInteger(source.server) && Math.floor(source.server / 10000) === 16,
    'incompatible source server version',
  );
  requireCheck(
    typeof source.system === 'string' &&
      /^\d+$/.test(source.system) &&
      Array.isArray(source.locale) &&
      source.locale.length === 6 &&
      source.locale[0] === 'UTF8' &&
      typeof source.database === 'string',
    'incomplete source identity',
  );
  requireCheck(
    Number.isSafeInteger(details.bytes) && details.bytes > 0 && validSha(details.sha256),
    'incomplete archive metadata',
  );
  requireCheck(
    Number.isInteger(checks.table_count) &&
      checks.table_count > 0 &&
      [
        checks.schema_sha256,
        checks.ledger_totals_sha256,
        checks.tables_sha256,
        checks.rows_sha256,
      ].every(validSha),
    'incomplete verification metadata',
  );
  requireCheck(
    Array.isArray(manifest.boundary_utc) &&
      manifest.boundary_utc.length === 2 &&
      manifest.boundary_utc.every((value) => typeof value === 'string' && value),
    'incomplete snapshot boundary',
  );
  requireCheck(
    Object.keys(manifest.tools).length === toolNames.length,
    'incomplete tool version metadata',
  );
  for (const name of toolNames) {
    const version = manifest.tools[name];
    requireCheck(
      typeof version === 'string' &&
        /^16\.\d+$/.test(version) &&
        patch(tools[name]) >= patch(version),
      'incompatible PostgreSQL client version',
    );
  }
  return { manifest, archive };
}

async function checkArchive(manifest: Manifest, archive: string) {
  requireCheck(
    (await lstat(archive)).size === manifest.archive.bytes &&
      (await fileHash(archive)) === manifest.archive.sha256,
    'backup archive checksum or size mismatch',
  );
  await run(
    ['pg_restore', '--list', archive],
    undefined,
    undefined,
    'invalid PostgreSQL custom archive',
  );
}

async function checkTarget(env: Env, manifest: Manifest, tools: Versions, empty: boolean) {
  const target = await identity(env);
  requireCheck(
    target.system !== manifest.source.system,
    'source and target share a PostgreSQL cluster',
  );
  requireCheck(
    target.server >= manifest.source.server,
    'target PostgreSQL patch predates the source',
  );
  requireCheck(
    patch(tools.pg_restore) >= target.server % 10000,
    'restore clients must be at least as recent as the target server',
  );
  requireCheck(
    JSON.stringify(target.locale) === JSON.stringify(manifest.source.locale),
    'target encoding or collation differs',
  );
  const isolated = await run(
    [...psql, '-v', `socket=${env.PGHOST}`],
    env,
    `
SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses') = ''
    AND current_setting('unix_socket_directories') = :'socket'
    AND current_setting('is_superuser') = 'on' AND NOT pg_is_in_recovery()
    AND NOT EXISTS (SELECT FROM pg_database WHERE NOT datistemplate
                    AND datname NOT IN ('postgres', current_database()))
    AND NOT EXISTS (SELECT FROM pg_prepared_xacts)
    AND NOT EXISTS (SELECT FROM pg_stat_activity
                    WHERE backend_type = 'client backend' AND pid <> pg_backend_pid());
`,
  );
  requireCheck(
    isolated === 't',
    'target must be a dedicated socket-only recovery cluster with no other clients',
  );
  if (empty) requireCheck((await run(psql, env, EMPTY)) === 't', 'restore target is not empty');
}

async function verify(env: Env, manifest: Manifest, local: Compatibility) {
  const actual = await withSnapshot(env, (token) => evidence(env, token, local));
  requireCheck(
    isDeepStrictEqual(actual, manifest.checks),
    'restored schema, contents or ledger totals differ from the backup snapshot',
  );
  await run(
    psql,
    env,
    await readFile(join(import.meta.dir, 'portable-verify.sql'), 'utf8'),
    'tenant isolation or immutability probe failed',
  );
}

async function main() {
  const started = performance.now();
  const command = process.argv[2];
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    allowPositionals: true,
    options: {
      source: { type: 'string' },
      socket: { type: 'string' },
      port: { type: 'string' },
      database: { type: 'string' },
      user: { type: 'string' },
      'host-migrations': { type: 'string' },
    },
  });
  requireCheck(positionals.length === 1, 'supply a single bundle directory');
  const [bundle] = positionals;
  const local = await compatibility(values['host-migrations']);
  const tools = await toolVersions();
  if (command === 'backup') {
    requireCheck(
      values.source &&
        Object.keys(values).every((key) => key === 'source' || key === 'host-migrations'),
      'backup requires --source SERVICE',
    );
    await backup(values.source, bundle, local, tools);
  } else {
    requireCheck(
      command === 'preflight' || command === 'restore' || command === 'verify',
      'use backup, preflight, restore or verify',
    );
    const { socket: socketPath, port, database, user } = values;
    requireCheck(
      !values.source && socketPath && port && /^\d+$/.test(port) && +port >= 1 && +port <= 65535,
      'supply an explicit --socket and valid --port',
    );
    const name = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;
    requireCheck(
      database && name.test(database) && !['postgres', 'template0', 'template1'].includes(database),
      'use an explicit --database recovery name',
    );
    requireCheck(user && name.test(user), 'supply a valid --user');
    const { manifest, archive } = await readBundle(bundle, local, tools);
    const socket = await realpath(socketPath);
    const directory = await lstat(socket);
    requireCheck(
      directory.isDirectory() &&
        directory.uid === process.getuid?.() &&
        (directory.mode & 0o777) === 0o700,
      'restore socket directory must be owned and mode 0700',
    );
    const env = dbEnv({ PGHOST: socket, PGPORT: port, PGDATABASE: database, PGUSER: user });
    // The private directory lock survives a hard kill and blocks another attempt until inspected.
    const lock = join(socket, '.borecount-recovery.lock');
    await mkdir(lock, { mode: 0o700 }).catch(() => {
      throw new Rejected('recovery lock in use or cannot be created');
    });
    try {
      await checkTarget(env, manifest, tools, command !== 'verify');
      if (command === 'restore') {
        await withScratch(join(tmpdir(), 'borecount-restore-'), async (scratch) => {
          const checked = join(scratch, 'database.dump');
          await copyFile(archive, checked);
          await chmod(checked, 0o600);
          await checkArchive(manifest, checked);
          await checkTarget(env, manifest, tools, true);
          await run(
            [
              'pg_restore',
              '--no-password',
              '--no-tablespaces',
              '--single-transaction',
              '--exit-on-error',
              '--dbname',
              database,
              checked,
            ],
            env,
            undefined,
            'atomic restore failed; check roles, extensions and target state',
          );
        });
      } else {
        await checkArchive(manifest, archive);
      }
      if (command !== 'preflight') {
        await verify(env, manifest, local);
        console.log('SQL verification passed. Complete host/API checks before enabling access.');
      }
    } finally {
      await rmdir(lock);
    }
  }
  console.log(`${command} elapsed: ${((performance.now() - started) / 1000).toFixed(2)}s`);
}

process.umask(0o077);
try {
  await main();
} catch (error) {
  const message = controller.signal.aborted
    ? 'Interrupted. Keep the target offline and check its state before retrying.'
    : `Rejected: ${error instanceof Rejected ? error.message : 'malformed metadata, filesystem error or missing tool'}`;
  console.error(message);
  process.exitCode = 1;
}
