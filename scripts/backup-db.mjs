import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Dumps the whole Supabase database (roles, schema, then data including Auth) into
// .local/backups/db-<timestamp>/ as roles.sql, schema.sql and data.sql. It uses the same flags
// and filters as `supabase db dump`, so docs/BACKUP-AND-RESTORE.md restores either kind.
// The connection string is read only from SUPABASE_DB_URL and is never printed.
//
//   npm run backup:db                       (pg_dump if installed, else supabase db dump)
//   npm run backup:db -- --tool=pg_dump     (or --tool=supabase, --out=<folder>)

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SUPABASE_CLI = join(ROOT, 'node_modules', 'supabase', 'dist', 'supabase.js');

// The schema, role and setting lists `supabase db dump` uses (Supabase CLI 2.117).
const SCHEMA_EXCLUDED = [
  'information_schema',
  'pg_*',
  '_analytics',
  '_realtime',
  '_supavisor',
  'auth',
  'etl',
  'extensions',
  'pgbouncer',
  'realtime',
  'storage',
  'supabase_functions',
  'supabase_migrations',
  'cron',
  'dbdev',
  'graphql',
  'graphql_public',
  'net',
  'pgmq',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'repack',
  'tiger',
  'tiger_data',
  'timescaledb_*',
  '_timescaledb_*',
  'topology',
  'vault',
];
// Data keeps auth, storage and cron rows: logins and memberships depend on auth.users.
const DATA_EXCLUDED = [
  'information_schema',
  'pg_*',
  'graphql',
  'graphql_public',
  'pgsodium',
  'pgsodium_masks',
  'pgtle',
  'repack',
  'tiger',
  'tiger_data',
  'timescaledb_*',
  '_timescaledb_*',
  'topology',
  'vault',
  'etl',
  'extensions',
  'pgbouncer',
  'realtime',
  'supabase_migrations',
  '_analytics',
  '_realtime',
  '_supavisor',
];
const RESERVED_ROLES = [
  'anon',
  'authenticated',
  'authenticator',
  'cli_login_.*',
  'dashboard_user',
  'pgbouncer',
  'postgres',
  'service_role',
  'supabase_.*',
  'pgsodium_keyholder',
  'pgsodium_keyiduser',
  'pgsodium_keymaker',
  'pgtle_admin',
].join('|');
const ALLOWED_CONFIGS = [
  'pgaudit.*',
  'pgrst.*',
  'session_replication_role',
  'statement_timeout',
  'track_io_timing',
].join('|');
const EXCLUDED = SCHEMA_EXCLUDED.join('|');

const comment = (pattern) => (line) => line.replace(pattern, '-- $&');
const swap = (pattern, to) => (line) => line.replace(pattern, to);
const dropComments = (line) => (line.startsWith('--') ? undefined : line);
const restrict = comment(/^\\(un)?restrict .*$/);

// Line filters, in the order the CLI's sed pipeline applies them. undefined drops the line.
export const FILTERS = {
  roles: [
    restrict,
    comment(new RegExp(`^CREATE ROLE "(${RESERVED_ROLES})"`)),
    comment(new RegExp(`^ALTER ROLE "(${RESERVED_ROLES})"`)),
    (line) => line.replace(/ (NOSUPERUSER|NOREPLICATION)/g, ''),
    swap(new RegExp(`^-- (.* SET "(${ALLOWED_CONFIGS})" .*)`), '$1'),
    comment(new RegExp(`GRANT ".*" TO "(${RESERVED_ROLES})"`)),
    dropComments,
  ],
  schema: [
    restrict,
    swap(/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "'),
    swap(/^CREATE TABLE "/, 'CREATE TABLE IF NOT EXISTS "'),
    swap(/^CREATE SEQUENCE "/, 'CREATE SEQUENCE IF NOT EXISTS "'),
    swap(/^CREATE VIEW "/, 'CREATE OR REPLACE VIEW "'),
    swap(/^CREATE FUNCTION "/, 'CREATE OR REPLACE FUNCTION "'),
    swap(/^CREATE TRIGGER "/, 'CREATE OR REPLACE TRIGGER "'),
    comment(/^CREATE PUBLICATION "supabase_realtime/),
    comment(/^CREATE EVENT TRIGGER /),
    comment(/^ {9}WHEN TAG IN /),
    comment(/^ {3}EXECUTE FUNCTION /),
    comment(/^ALTER EVENT TRIGGER /),
    comment(/^ALTER PUBLICATION "supabase_realtime_/),
    comment(/^ALTER FOREIGN DATA WRAPPER (.+) OWNER TO /),
    comment(/^ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"/),
    comment(/^GRANT ALL ON FOREIGN DATA WRAPPER (.+) TO "postgres" WITH GRANT OPTION/),
    comment(new RegExp(`^GRANT (.+) ON (.+) "(${EXCLUDED})"`)),
    comment(new RegExp(`^REVOKE (.+) ON (.+) "(${EXCLUDED})"`)),
    swap(/^(CREATE EXTENSION IF NOT EXISTS "pg_tle").+/, '$1;'),
    swap(/^(CREATE EXTENSION IF NOT EXISTS "pgsodium").+/, '$1;'),
    swap(/^(CREATE EXTENSION IF NOT EXISTS "pgmq").+/, '$1;'),
    comment(/^COMMENT ON EXTENSION (.+)/),
    comment(/^CREATE POLICY "cron_job_/),
    comment(/^ALTER TABLE "cron"/),
    comment(/^SET transaction_timeout = 0;/),
    dropComments,
  ],
  // SQL comments stay in data: a multi-line value may begin with "--".
  data: [restrict],
};

const STEPS = [
  {
    kind: 'roles',
    file: 'roles.sql',
    program: 'pg_dumpall',
    args: [
      '--roles-only',
      '--role',
      'postgres',
      '--quote-all-identifier',
      '--no-role-passwords',
      '--no-comments',
    ],
    cli: ['--role-only'],
    after: 'RESET ALL;\n',
  },
  {
    kind: 'schema',
    file: 'schema.sql',
    program: 'pg_dump',
    args: [
      '--schema-only',
      '--quote-all-identifier',
      '--role',
      'postgres',
      '--exclude-schema',
      EXCLUDED,
    ],
    cli: [],
    // The restore drill checks for these, so a dump without them is not a backup.
    expect: ['CREATE TABLE IF NOT EXISTS "public"."companies"'],
  },
  {
    kind: 'data',
    file: 'data.sql',
    program: 'pg_dump',
    args: [
      '--data-only',
      '--quote-all-identifier',
      '--role',
      'postgres',
      '--exclude-schema',
      DATA_EXCLUDED.join('|'),
      '--exclude-table',
      'auth.schema_migrations',
      '--exclude-table',
      'storage.migrations',
      '--exclude-table',
      'supabase_functions.migrations',
      '--schema',
      '*',
    ],
    cli: ['--data-only', '--use-copy'],
    before: 'SET session_replication_role = replica;\n\n',
    after: 'RESET ALL;\n',
    expect: ['COPY "public"."companies"', 'COPY "auth"."users"'],
  },
];

export class BackupError extends Error {}

/** libpq settings for a postgres:// URL. The password travels in PGPASSWORD, never in argv. */
export function connectionEnv(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    url = undefined;
  }
  if (!url || !['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
    throw new BackupError(
      'SUPABASE_DB_URL is not a Postgres connection string. Copy the Session pooler string from Supabase → Connect (it starts with postgresql).',
    );
  if (!url.password)
    throw new BackupError(
      'SUPABASE_DB_URL has no password. Put the database password in place of [YOUR-PASSWORD].',
    );
  const warnings = [];
  if (url.port === '6543')
    warnings.push(
      'This is the Transaction pooler (port 6543). pg_dump needs the Session pooler (port 5432).',
    );
  return {
    env: {
      PGHOST: url.hostname,
      PGPORT: url.port || '5432',
      PGUSER: decodeURIComponent(url.username || 'postgres'),
      PGPASSWORD: decodeURIComponent(url.password),
      PGDATABASE: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
      PGSSLMODE: url.searchParams.get('sslmode') || 'require',
    },
    warnings,
  };
}

/** Removes the connection string and password from text that is about to be shown. */
export function redact(text, raw) {
  let out = String(text ?? '');
  const secrets = [String(raw ?? '')];
  try {
    const url = new URL(String(raw ?? ''));
    if (url.password) secrets.push(url.password, decodeURIComponent(url.password));
  } catch {}
  for (const secret of secrets.filter((s) => s.length >= 4).sort((a, b) => b.length - a.length))
    out = out.split(secret).join('[hidden]');
  return out.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[hidden]');
}

/** Applies a filter list to lines; a carriage return at the end of a line is kept as it was. */
export function filterLines(lines, filters) {
  const out = [];
  let previous;
  for (const raw of lines) {
    const cr = raw.endsWith('\r');
    let line = cr ? raw.slice(0, -1) : raw;
    for (const filter of filters) {
      line = filter(line);
      if (line === undefined) break;
    }
    if (line === undefined) continue;
    const kept = cr ? `${line}\r` : line;
    // Like `uniq` on the role list: the dropped comments leave repeated blank lines.
    if (filters === FILTERS.roles && kept === previous) continue;
    out.push(kept);
    previous = kept;
  }
  return out;
}

export function backupFolderName(date = new Date()) {
  return `db-${date.toISOString().slice(0, 19).replace(/:/g, '-')}Z`;
}

/** Picks the dump tool: pg_dump when installed, otherwise the Supabase CLI, which needs Docker. */
export function chooseTool({ requested = 'auto', pgDump, docker }) {
  if (!['auto', 'pg_dump', 'supabase'].includes(requested))
    throw new BackupError(`Unknown --tool "${requested}". Use pg_dump or supabase.`);
  if (requested === 'pg_dump' || (requested === 'auto' && pgDump)) {
    if (pgDump) return 'pg_dump';
    throw new BackupError(PG_DUMP_MISSING);
  }
  if (docker) return 'supabase';
  throw new BackupError(
    requested === 'supabase'
      ? DOCKER_MISSING
      : `No dump tool is available.\n- ${PG_DUMP_MISSING}\n- ${DOCKER_MISSING}`,
  );
}

const PG_DUMP_MISSING =
  'pg_dump was not found. Install the PostgreSQL 17 client tools (for example `winget install PostgreSQL.PostgreSQL.17`, or the EDB installer with only "Command Line Tools"), then add its bin folder to PATH or set PG_BIN to it, e.g. C:\\Program Files\\PostgreSQL\\17\\bin.';
const DOCKER_MISSING =
  '`supabase db dump` runs pg_dump inside a Docker container, also on Windows. Start Docker Desktop and try again, or install pg_dump instead.';

const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);

/** Finds pg_dump and pg_dumpall: PG_BIN only when it is set, else PATH, else the Windows installs. */
export function findPgTools(env = process.env) {
  const candidates = [];
  if (env.PG_BIN) candidates.push(env.PG_BIN);
  else {
    candidates.push('');
    const base = 'C:\\Program Files\\PostgreSQL';
    if (process.platform === 'win32' && existsSync(base))
      for (const version of readdirSync(base)
        .filter((name) => /^\d+$/.test(name))
        .sort((a, b) => Number(b) - Number(a)))
        candidates.push(join(base, version, 'bin'));
  }
  for (const dir of candidates) {
    const pgDump = dir ? join(dir, exe('pg_dump')) : 'pg_dump';
    const pgDumpAll = dir ? join(dir, exe('pg_dumpall')) : 'pg_dumpall';
    if (dir && !(existsSync(pgDump) && existsSync(pgDumpAll))) continue;
    const version = spawnSync(pgDump, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (version.status === 0)
      return {
        pgDump,
        pgDumpAll,
        version: version.stdout.trim(),
        major: Number(version.stdout.match(/(\d+)\./)?.[1] ?? 0),
      };
  }
  return undefined;
}

function dockerRunning() {
  const run = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], {
    encoding: 'utf8',
    timeout: 20000,
  });
  return run.status === 0;
}

/** Runs one dump, filtering its output line by line into the file. */
function dumpWithPgTools(step, tools, connection, path, raw) {
  return new Promise((resolvePromise, reject) => {
    const program = step.program === 'pg_dumpall' ? tools.pgDumpAll : tools.pgDump;
    const child = spawn(program, ['--no-password', ...step.args], {
      env: { ...process.env, ...connection.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const out = createWriteStream(path, { mode: 0o600 });
    const decoder = new StringDecoder('utf8');
    let rest = '';
    let previous;
    let stderr = '';
    const write = (lines) => {
      const kept = filterLines(lines, FILTERS[step.kind]);
      // Keep `uniq` working across chunk boundaries for the role list.
      if (step.kind === 'roles' && kept.length && kept[0] === previous) kept.shift();
      if (kept.length) {
        previous = kept[kept.length - 1];
        // Large data dumps wait for the disk instead of piling up in memory.
        if (!out.write(`${kept.join('\n')}\n`)) {
          child.stdout.pause();
          out.once('drain', () => child.stdout.resume());
        }
      }
    };
    if (step.before) out.write(step.before);
    child.stdout.on('data', (chunk) => {
      const lines = (rest + decoder.write(chunk)).split('\n');
      rest = lines.pop() ?? '';
      write(lines);
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let failed = false;
    out.on('error', (error) => {
      failed = true;
      child.kill();
      reject(new BackupError(`Could not write ${step.file}: ${error.message}`));
    });
    child.on('error', (error) => {
      failed = true;
      // Close the file first, so the incomplete folder can be removed on Windows.
      out.end(() => reject(new BackupError(`${step.program} could not start: ${error.message}`)));
    });
    child.on('close', (code) => {
      if (failed) return;
      const tail = rest + decoder.end();
      if (tail) write([tail]);
      if (step.after) out.write(step.after);
      out.end(() => {
        if (code === 0) return resolvePromise();
        reject(
          new BackupError(explainFailure(step.program, redact(stderr, raw), connection.env.PGHOST)),
        );
      });
    });
  });
}

function dumpWithSupabaseCli(step, path, raw) {
  return new Promise((resolvePromise, reject) => {
    // Node runs the CLI's own script, so no shell ever sees the connection string.
    const child = spawn(
      process.execPath,
      [SUPABASE_CLI, 'db', 'dump', '--db-url', String(raw).trim(), '-f', path, ...step.cli],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      reject(new BackupError(`The Supabase CLI could not start: ${error.message}`)),
    );
    child.on('close', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new BackupError(explainFailure('supabase db dump', redact(stderr, raw), ''))),
    );
  });
}

function explainFailure(program, stderr, host) {
  const hints = [];
  if (/server version mismatch|aborting because of server version/i.test(stderr))
    hints.push(
      'Your pg_dump is older than the database. Install the PostgreSQL 17 client tools and set PG_BIN.',
    );
  if (/password authentication failed/i.test(stderr))
    hints.push(
      'The database password in SUPABASE_DB_URL is wrong. Reset it in Supabase → Database settings if needed.',
    );
  if (/could not translate host|Network is unreachable|could not connect|timeout/i.test(stderr))
    hints.push(
      host.startsWith('db.')
        ? 'The direct database host needs IPv6. Use the Session pooler connection string instead.'
        : 'Check the internet connection and that the connection string is the Session pooler one.',
    );
  if (/docker/i.test(stderr)) hints.push(DOCKER_MISSING);
  return [`${program} failed.`, stderr.trim().split('\n').slice(-12).join('\n'), ...hints]
    .filter(Boolean)
    .join('\n');
}

async function fileContains(path, prefixes) {
  const missing = new Set(prefixes);
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    for (const prefix of missing) if (line.startsWith(prefix)) missing.delete(prefix);
    if (!missing.size) break;
  }
  lines.close();
  return [...missing];
}

function sha256(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', reject);
  });
}

const size = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;

function parseArgs(argv) {
  const options = { tool: 'auto', out: join(process.cwd(), '.local', 'backups') };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === '--tool') options.tool = value();
    else if (flag === '--out') options.out = resolve(value());
    else
      throw new BackupError(
        `Unknown option ${flag}. Use --tool=pg_dump|supabase or --out=<folder>.`,
      );
  }
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv);
  const raw = env.SUPABASE_DB_URL;
  if (!raw)
    throw new BackupError(
      'Set SUPABASE_DB_URL to the database connection string (Supabase → Connect → Session pooler). It is read from the environment and never printed.',
    );
  const connection = connectionEnv(raw);
  for (const warning of connection.warnings) console.warn(`Warning: ${warning}`);
  const wantsPg = options.tool !== 'supabase';
  const tools = wantsPg ? findPgTools(env) : undefined;
  if (wantsPg && !tools && env.PG_BIN)
    throw new BackupError(
      `PG_BIN is set to ${env.PG_BIN}, but no working pg_dump and pg_dumpall are there. ${PG_DUMP_MISSING}`,
    );
  const tool = chooseTool({
    requested: options.tool,
    pgDump: !!tools,
    docker: !tools && options.tool !== 'pg_dump' && existsSync(SUPABASE_CLI) && dockerRunning(),
  });
  if (tool === 'pg_dump' && tools.major && tools.major < 15)
    console.warn(
      `Warning: ${tools.version} is older than Supabase's Postgres; install version 17.`,
    );
  const folder = join(options.out, backupFolderName());
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  console.log(
    `Backing up with ${tool === 'pg_dump' ? tools.version : 'supabase db dump (Docker)'}.`,
  );
  try {
    const files = [];
    for (const step of STEPS) {
      const path = join(folder, step.file);
      process.stdout.write(`Dumping ${step.kind}… `);
      if (tool === 'pg_dump') await dumpWithPgTools(step, tools, connection, path, raw);
      else await dumpWithSupabaseCli(step, path, raw);
      const missing = step.expect ? await fileContains(path, step.expect) : [];
      if (missing.length)
        throw new BackupError(
          `${step.file} is missing ${missing.join(' and ')}. This is not a complete Orderly backup.`,
        );
      const bytes = statSync(path).size;
      files.push({ name: step.file, bytes, sha256: await sha256(path) });
      console.log(size(bytes));
    }
    writeFileSync(
      join(folder, 'manifest.json'),
      `${JSON.stringify({ createdAt: new Date().toISOString(), tool: tool === 'pg_dump' ? tools.version : 'supabase db dump', files, restore: 'docs/BACKUP-AND-RESTORE.md' }, null, 2)}\n`,
    );
  } catch (error) {
    // A partial dump still holds personal data and must not pass for a backup.
    rmSync(folder, { recursive: true, force: true });
    throw error;
  }
  console.log(
    `Backup written to ${relative(process.cwd(), folder) || folder}.\nIt holds customer details and encrypted credentials: encrypt it and copy it off this laptop (docs/BACKUP-AND-RESTORE.md).`,
  );
  return folder;
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href.toLowerCase();
if (invoked === import.meta.url.toLowerCase())
  main().catch((error) => {
    console.error(
      error instanceof BackupError
        ? `Backup failed: ${redact(error.message, process.env.SUPABASE_DB_URL)}`
        : `Backup failed unexpectedly: ${redact(error?.stack ?? error, process.env.SUPABASE_DB_URL)}`,
    );
    process.exitCode = 1;
  });
