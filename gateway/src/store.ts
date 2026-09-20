import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Each restaurant has a separate encrypted database. AAD prevents row swapping.
export class Store {
  private db: DatabaseSync;
  constructor(
    path: string,
    private key: Buffer,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (namespace TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(namespace,id)); CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, expires INTEGER NOT NULL)',
    );
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS gateway_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires INTEGER NOT NULL)',
    );
  }
  get<T>(namespace: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM records WHERE namespace=? AND id=?')
      .get(namespace, id) as { value: string } | undefined;
    if (!row) return;
    const [nonce, tag, body] = row.value.split('.').map((s) => Buffer.from(s, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(Buffer.from(`${namespace}:${id}`));
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString());
  }
  set(namespace: string, id: string, value: unknown) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(`${namespace}:${id}`));
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    this.db
      .prepare(
        'INSERT INTO records VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value',
      )
      .run(
        namespace,
        id,
        [nonce, cipher.getAuthTag(), body].map((b) => b.toString('base64')).join('.'),
      );
  }
  delete(namespace: string, id: string) {
    this.db.prepare('DELETE FROM records WHERE namespace=? AND id=?').run(namespace, id);
  }
  clear(namespace: string) {
    this.db.prepare('DELETE FROM records WHERE namespace=?').run(namespace);
  }
  count(namespace: string) {
    return Number(
      (
        this.db
          .prepare('SELECT count(*) AS total FROM records WHERE namespace=?')
          .get(namespace) as { total: number }
      ).total,
    );
  }
  list<T>(namespace: string, limit = 100000): { id: string; value: T }[] {
    return (
      this.db
        .prepare('SELECT id FROM records WHERE namespace=? ORDER BY rowid LIMIT ?')
        .all(namespace, limit) as { id: string }[]
    ).map((row) => ({ id: row.id, value: this.get<T>(namespace, row.id)! }));
  }
  nonce(nonce: string) {
    this.db.prepare('DELETE FROM nonces WHERE expires < ?').run(Date.now());
    return (
      this.db.prepare('INSERT OR IGNORE INTO nonces VALUES(?,?)').run(nonce, Date.now() + 120000)
        .changes === 1
    );
  }
  lease(owner: string): boolean {
    return (
      this.db
        .prepare(
          'INSERT INTO gateway_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE gateway_lease.owner=excluded.owner OR gateway_lease.expires < ?',
        )
        .run(owner, Date.now() + 45000, Date.now()).changes === 1
    );
  }
  releaseLease(owner: string) {
    this.db.prepare('DELETE FROM gateway_lease WHERE owner=?').run(owner);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
