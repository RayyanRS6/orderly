import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Filter = (line: string) => string | undefined;
type BackupModule = {
  FILTERS: Record<'roles' | 'schema' | 'data', Filter[]>;
  filterLines: (lines: string[], filters: Filter[]) => string[];
  connectionEnv: (raw: string) => { env: Record<string, string>; warnings: string[] };
  redact: (text: string, raw: string) => string;
  chooseTool: (options: { requested?: string; pgDump: boolean; docker: boolean }) => string;
  backupFolderName: (date?: Date) => string;
};
const load = async () => (await import('../scripts/backup-db.mjs' as string)) as BackupModule;
const root = process.cwd();
const SECRET = 'Sup3r-Secret-Pass';
const URL_WITH_SECRET = `postgresql://postgres.abcdefgh:${SECRET}@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres`;

describe('database backup script', () => {
  it('is wired up as npm run backup:db', () => {
    const scripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
    expect(scripts['backup:db']).toBe('node scripts/backup-db.mjs');
  });

  it('passes the password to pg_dump only through the environment', async () => {
    const { connectionEnv } = await load();
    const { env, warnings } = connectionEnv(
      'postgresql://postgres.abcdefgh:p%40ss%3Aword@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres',
    );
    expect(env).toEqual({
      PGHOST: 'aws-0-ap-southeast-2.pooler.supabase.com',
      PGPORT: '5432',
      PGUSER: 'postgres.abcdefgh',
      PGPASSWORD: 'p@ss:word',
      PGDATABASE: 'postgres',
      PGSSLMODE: 'require',
    });
    expect(warnings).toEqual([]);
    expect(connectionEnv(URL_WITH_SECRET.replace(':5432', ':6543')).warnings[0]).toContain(
      'Session pooler',
    );
    expect(() => connectionEnv(`https://${SECRET}@example.com`)).toThrow(/Session pooler/);
    expect(() => connectionEnv(`https://${SECRET}@example.com`)).not.toThrow(SECRET);
    expect(() => connectionEnv('postgresql://postgres@host:5432/postgres')).toThrow(/no password/);
  });

  it('hides the connection string and password in anything it prints', async () => {
    const { redact } = await load();
    const shown = redact(
      `FATAL: password authentication failed: ${SECRET} via ${URL_WITH_SECRET} or postgres://x:y@h/db`,
      URL_WITH_SECRET,
    );
    expect(shown).not.toContain(SECRET);
    expect(shown).not.toContain('pooler.supabase.com');
    expect(shown).not.toContain('x:y@h');
  });

  it('filters the role list like supabase db dump', async () => {
    const { FILTERS, filterLines } = await load();
    expect(
      filterLines(
        [
          '--',
          '-- PostgreSQL database cluster dump',
          '\\restrict abc',
          'CREATE ROLE "anon";',
          'ALTER ROLE "anon" WITH NOSUPERUSER INHERIT NOLOGIN NOREPLICATION;',
          'ALTER ROLE "authenticator" SET "statement_timeout" TO \'8s\';',
          'CREATE ROLE "supabase_admin";',
          'CREATE ROLE "orderly_reader";',
          'ALTER ROLE "orderly_reader" WITH NOSUPERUSER LOGIN NOREPLICATION;',
          'GRANT "orderly_reader" TO "postgres" GRANTED BY "supabase_admin";',
          '',
          '',
          '\\unrestrict abc',
        ],
        FILTERS.roles,
      ),
    ).toEqual([
      'ALTER ROLE "authenticator" SET "statement_timeout" TO \'8s\';',
      'CREATE ROLE "orderly_reader";',
      'ALTER ROLE "orderly_reader" WITH LOGIN;',
      '',
    ]);
  });

  it('makes the schema restorable into a fresh Supabase project', async () => {
    const { FILTERS, filterLines } = await load();
    expect(
      filterLines(
        [
          '-- Name: companies; Type: TABLE',
          'CREATE SCHEMA "public";',
          'CREATE TABLE "public"."companies" (',
          'CREATE FUNCTION "public"."f"() RETURNS void\r',
          'CREATE EXTENSION IF NOT EXISTS "pgsodium" WITH SCHEMA "pgsodium";',
          'COMMENT ON EXTENSION "pg_cron" IS \'cron\';',
          'CREATE EVENT TRIGGER "issue_pg_cron_access" ON "ddl_command_end"',
          'GRANT USAGE ON SCHEMA "graphql_public" TO "anon";',
          'GRANT ALL ON TABLE "public"."companies" TO "service_role";',
          'ALTER TABLE "cron"."job" ENABLE ROW LEVEL SECURITY;',
          'SET transaction_timeout = 0;',
        ],
        FILTERS.schema,
      ),
    ).toEqual([
      'CREATE SCHEMA IF NOT EXISTS "public";',
      'CREATE TABLE IF NOT EXISTS "public"."companies" (',
      // A Windows line ending inside a function body is kept as it was.
      'CREATE OR REPLACE FUNCTION "public"."f"() RETURNS void\r',
      'CREATE EXTENSION IF NOT EXISTS "pgsodium";',
      'GRANT ALL ON TABLE "public"."companies" TO "service_role";',
    ]);
    // Data keeps comment-like lines, since a value may start with "--".
    expect(
      filterLines(['\\restrict k', '-- a value', 'COPY "auth"."users"'], FILTERS.data),
    ).toEqual(['-- \\restrict k', '-- a value', 'COPY "auth"."users"']);
  });

  it('prefers pg_dump, falls back to Docker, and says how to fix neither', async () => {
    const { chooseTool } = await load();
    expect(chooseTool({ pgDump: true, docker: true })).toBe('pg_dump');
    expect(chooseTool({ pgDump: false, docker: true })).toBe('supabase');
    expect(() => chooseTool({ requested: 'pg_dump', pgDump: false, docker: true })).toThrow(
      /PostgreSQL 17 client tools/,
    );
    expect(() => chooseTool({ requested: 'supabase', pgDump: true, docker: false })).toThrow(
      /Docker/,
    );
    expect(() => chooseTool({ pgDump: false, docker: false })).toThrow(/pg_dump[\s\S]*Docker/);
    expect(() => chooseTool({ requested: 'mysqldump', pgDump: true, docker: true })).toThrow(
      /Unknown --tool/,
    );
  });

  it('names each backup folder by its UTC time', async () => {
    const { backupFolderName } = await load();
    expect(backupFolderName(new Date('2026-10-18T22:15:03.456Z'))).toBe('db-2026-10-18T22-15-03Z');
  });

  it('fails with a plain message, prints no secret and leaves no folder', () => {
    const out = mkdtempSync(join(tmpdir(), 'orderly-backup-'));
    const emptyBin = mkdtempSync(join(tmpdir(), 'orderly-pgbin-'));
    try {
      const env = { ...process.env };
      for (const key of Object.keys(env))
        if (/^(SUPABASE_DB_URL|PG_BIN)$/i.test(key)) delete env[key];
      // PG_BIN pointing at an empty folder means no pg_dump is found and nothing connects.
      const run = (extra: Record<string, string>) =>
        spawnSync(
          process.execPath,
          [join(root, 'scripts/backup-db.mjs'), `--out=${out}`, '--tool=pg_dump'],
          { cwd: out, encoding: 'utf8', env: { ...env, ...extra } },
        );
      const missing = run({});
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('Set SUPABASE_DB_URL');

      const noTools = run({ SUPABASE_DB_URL: URL_WITH_SECRET, PG_BIN: emptyBin });
      expect(noTools.status).toBe(1);
      expect(noTools.stderr).toContain('PG_BIN is set');
      expect(noTools.stderr).toContain('PostgreSQL 17 client tools');
      expect(noTools.stdout + noTools.stderr).not.toContain(SECRET);
      expect(noTools.stdout + noTools.stderr).not.toContain('pooler.supabase.com');
      expect(existsSync(out) ? readdirSync(out) : []).toEqual([]);
    } finally {
      rmSync(out, { recursive: true, force: true });
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });
});
