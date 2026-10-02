#!/usr/bin/env node
/**
 * Applies a .sql file to the Supabase Postgres instance.
 *
 *   node scripts/applySql.js db/schema.sql
 *   npm run db:push
 *   npm run db:seed
 *
 * Requires DATABASE_URL — the pooler/direct connection string from
 * Supabase → Project Settings → Database → Connection string → URI.
 * (The REST API cannot run DDL, so this talks straight to Postgres.)
 *
 * The whole file runs as a single multi-statement query inside one implicit
 * transaction: if any statement fails, nothing is applied.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config();

const file = process.argv[2];

if (!file) {
  console.error('Usage: node scripts/applySql.js <path-to-sql-file>');
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error(
    '\nDATABASE_URL is not set.\n\n' +
      'Find it in Supabase → Project Settings → Database → Connection string → URI,\n' +
      'then add it to .env:\n\n' +
      '  DATABASE_URL=postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres\n\n' +
      `Alternatively, paste ${file} into the Supabase SQL Editor and run it there.\n`,
  );
  process.exit(1);
}

const path = resolve(process.cwd(), file);
const sql = await readFile(path, 'utf8');

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  // Supabase terminates TLS with its own CA chain; this is a direct admin
  // connection from a trusted machine, not a path user data flows over.
  ssl: { rejectUnauthorized: false },
  statement_timeout: 120_000,
});

console.log(`→ Applying ${file} …`);

try {
  await client.connect();
  const results = await client.query(sql);

  // A multi-statement query returns an array of results; surface any rows the
  // script selected (seed.sql ends with a verification SELECT).
  for (const result of Array.isArray(results) ? results : [results]) {
    if (result?.rows?.length) {
      console.table(result.rows);
    }
  }

  console.log(`✓ ${file} applied successfully.`);
} catch (error) {
  console.error(`\n✗ Failed to apply ${file}`);
  console.error(`  ${error.message}`);
  if (error.position) console.error(`  at character position ${error.position}`);
  if (error.hint) console.error(`  hint: ${error.hint}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
