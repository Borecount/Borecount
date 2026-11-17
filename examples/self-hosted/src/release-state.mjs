/**
 * Checks the installed package journal and the catalog shape of each applied prefix.
 * Recognizes the table/column/index DDL in the pinned release; this is not a general
 * SQL parser or a replacement for the library's full backup/invariant verification.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { borecountMigrationsPath } from '@borecount/postgres-adapter/migrations';

let installed;
function release() {
  return installed ??= (async () => {
    const journal = JSON.parse(await readFile(join(borecountMigrationsPath, 'meta/_journal.json'), 'utf8'));
    return Promise.all(journal.entries.map(async entry => {
      const source = await readFile(join(borecountMigrationsPath, `${entry.tag}.sql`), 'utf8');
      return { source, hash: createHash('sha256').update(source).digest('hex'), created_at: String(entry.when) };
    }));
  })();
}
function catalog(entries) {
  const tables = new Map(); const indexes = new Map();
  for (const { source } of entries) {
    for (const match of source.matchAll(/CREATE TABLE "([^"\n]+)" \(([\s\S]*?)\n\);/g)) {
      tables.set(match[1], new Set([...match[2].matchAll(/^\s*"([^"\n]+)" /gm)].map(column => column[1])));
    }
    for (const match of source.matchAll(/ALTER TABLE "([^"\n]+)" ADD COLUMN "([^"\n]+)"/g)) {
      if (!tables.has(match[1])) throw new Error('Unsupported installed migration shape');
      tables.get(match[1]).add(match[2]);
    }
    for (const match of source.matchAll(/CREATE (?:UNIQUE )?INDEX "([^"\n]+)" ON "([^"\n]+)"|DROP INDEX "([^"\n]+)"/g)) {
      if (match[3]) indexes.delete(match[3]); else indexes.set(match[1], match[2]);
    }
  }
  return { tables, indexes };
}
function sameNames(actual, expected) {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
export async function verifyReleaseState(connection, { allowPending = false } = {}) {
  const expected = await release();
  const [journal] = await connection`select to_regclass('drizzle.__drizzle_migrations') is not null as present`;
  const applied = journal.present
    ? await connection`select hash, created_at::text from drizzle.__drizzle_migrations order by created_at, id` : [];
  if (applied.length > expected.length || applied.some((row, i) =>
      row.hash !== expected[i].hash || row.created_at !== expected[i].created_at)) {
    throw new Error('Incompatible migration history');
  }
  if (!allowPending && applied.length !== expected.length) throw new Error('Pending package migrations');
  const shape = catalog(expected.slice(0, applied.length));
  const tables = await connection`select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p')`;
  if (!sameNames(tables.map(table => table.name), shape.tables.keys())) throw new Error('Unexpected package table inventory');
  const columns = await connection`select c.relname as table_name, a.attname as name from pg_attribute a
    join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped`;
  for (const [name, names] of shape.tables) {
    if (!sameNames(columns.filter(column => column.table_name === name).map(column => column.name), names)) {
      throw new Error('Unexpected package column inventory');
    }
  }
  const indexes = await connection`select i.relname as name, t.relname as table_name from pg_index x
    join pg_class i on i.oid=x.indexrelid join pg_class t on t.oid=x.indrelid
    join pg_namespace n on n.oid=t.relnamespace where n.nspname='public' and x.indisvalid and x.indisready`;
  for (const [name, table] of shape.indexes) {
    if (!indexes.some(index => index.name === name && index.table_name === table)) throw new Error('Missing package index');
  }
  return [...shape.tables.keys()];
}
