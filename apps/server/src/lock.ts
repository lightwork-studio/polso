import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * One server per data directory. The lock is an exclusive SQLite lock on a small file, held while
 * the server runs; the kernel drops it when the process ends, however it ends. Network
 * filesystems may not honour it, so keep the data directory on a local disk. `polso-server
 * admin` doesn't take it: it works on the database alongside the running server.
 */

export const LOCK_FILE = "polso-server.lock";

export class LockedError extends Error {
  override name = "LockedError";
}

/** Takes the data directory's lock, or throws when another server holds it. Returns a release. */
export function lockDataDirectory(directory: string): () => void {
  const db = new DatabaseSync(join(directory, LOCK_FILE));
  try {
    db.exec("PRAGMA busy_timeout = 0");
    // In exclusive mode the first write takes the lock, and it is kept until the connection closes.
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("CREATE TABLE IF NOT EXISTS holder (id INTEGER PRIMARY KEY, pid INTEGER, since TEXT)");
    db.prepare("INSERT OR REPLACE INTO holder (id, pid, since) VALUES (1, ?, ?)").run(
      process.pid,
      new Date().toISOString(),
    );
  } catch (error) {
    db.close();
    if (/locked|busy/i.test((error as Error).message)) {
      throw new LockedError(`Another Polso server uses ${directory}.`);
    }
    throw error;
  }
  return () => db.close();
}
