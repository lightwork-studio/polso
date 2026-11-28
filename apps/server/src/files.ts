import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DATABASE_FILE } from "./store.ts";

/**
 * Makes the data directory private to the server's user: new files through the umask, and a
 * directory or database that already existed (copied in, say) is tightened as well. Windows
 * ignores these modes.
 */
export function prepareDirectory(directory: string): void {
  process.umask(process.umask() | 0o077);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = join(directory, DATABASE_FILE + suffix);
    if (existsSync(file)) chmodSync(file, 0o600);
  }
}
