import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { Changes } from "./changes.ts";

/*
 * The server's one database: paired devices, pairing codes, and the copy of the owner's Health
 * data. The server and `polso-server admin` both open it; SQLite's locking keeps them apart, and
 * the server reads devices on every request, so a revoked device is locked out at once.
 */

export const DATABASE_FILE = "polso.db";

/** Each entry moves the schema up one version. Never edit one that has shipped; add another. */
export const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE devices (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE pairing_codes (
    code_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE samples (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    number_value REAL,
    text_value TEXT,
    unit TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX samples_by_type_and_end ON samples (type, end_ms);
  CREATE TABLE workouts (
    id TEXT PRIMARY KEY,
    activity TEXT NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    duration_minutes REAL NOT NULL,
    energy_value REAL,
    energy_unit TEXT,
    distance_value REAL,
    distance_unit TEXT,
    source TEXT NOT NULL
  );
  CREATE INDEX workouts_by_end ON workouts (end_ms);
  CREATE TABLE daily_stats (
    type TEXT NOT NULL,
    statistic TEXT NOT NULL,
    day TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    PRIMARY KEY (type, statistic, day)
  );
  CREATE TABLE characteristics (
    type TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export interface Device {
  readonly id: number;
  readonly name: string;
  readonly pairedAt: Date;
  readonly lastSeenAt?: Date;
}

interface DeviceRow {
  id: number;
  name: string;
  paired_at: number;
  last_seen_at: number | null;
}

const deviceOf = (row: DeviceRow): Device => ({
  id: row.id,
  name: row.name,
  pairedAt: new Date(row.paired_at),
  ...(row.last_seen_at !== null && { lastSeenAt: new Date(row.last_seen_at) }),
});

/** How often a device's last-seen time is written, so every request doesn't write. */
const LAST_SEEN_EVERY_MS = 60_000;

/** Settings that describe the Health data, cleared with it. Others (the server's own) stay. */
const DATA_SETTINGS = ["timeZone", "lastUploadAt"] as const;

export class MissingDatabaseError extends Error {
  override name = "MissingDatabaseError";
}

/** Blocks the thread briefly; only used while another process holds the database. */
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export const isBusy = (error: unknown) =>
  error instanceof Error && /database is locked|SQLITE_BUSY/i.test(error.message);

/** Retries `work` while another process holds a lock that busy_timeout doesn't wait for. */
function whileBusy<T>(work: () => T, tries = 50): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return work();
    } catch (error) {
      if (!isBusy(error) || attempt >= tries) throw error;
      pause(100);
    }
  }
}

const hasContent = (c: Changes) =>
  c.timeZone !== undefined ||
  c.samples.length > 0 ||
  c.workouts.length > 0 ||
  c.deleted.length > 0 ||
  c.dailyStats.length > 0 ||
  c.characteristics.length > 0;

export class Store {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * Opens the database and brings its schema up to date. The server creates it; admin commands
   * pass `create: false`, so a mistyped data directory fails instead of acting on an empty one.
   */
  static open(path: string, options: { create?: boolean } = {}): Store {
    if (options.create === false && !existsSync(path)) {
      throw new MissingDatabaseError(
        `No Polso database at ${path}. Set POLSO_DATA to the server's data directory.`,
      );
    }
    const db = new DatabaseSync(path);
    try {
      // Wait for the other process (server or admin) rather than failing at once.
      db.exec("PRAGMA busy_timeout = 5000");
      // Switching a new file to WAL doesn't honour busy_timeout, so it retries by hand.
      whileBusy(() => db.exec("PRAGMA journal_mode = WAL"));
      // Deleted Health records are overwritten in the file, not just unlinked.
      db.exec("PRAGMA synchronous = FULL; PRAGMA secure_delete = ON");
      const store = new Store(db);
      store.migrate();
      return store;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private version(): number {
    const { user_version: version } = this.db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version > MIGRATIONS.length) {
      throw new Error(
        `The database is from a newer Polso server (schema ${version}). Run that version.`,
      );
    }
    return version;
  }

  /**
   * Applies missing migrations. The version is read again under the write lock, so when the
   * server and an admin command open the database together, only one of them migrates.
   */
  private migrate(): void {
    if (this.version() === MIGRATIONS.length) return;
    this.transaction(() => {
      for (let next = this.version(); next < MIGRATIONS.length; next++) {
        this.db.exec(MIGRATIONS[next] as string);
      }
      this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    });
  }

  /** Runs `work` in one write transaction, rolled back if it throws. */
  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  // --- Devices and pairing ---

  addPairingCode(codeHash: string, expiresAt: Date): void {
    this.db
      .prepare("INSERT INTO pairing_codes (code_hash, expires_at) VALUES (?, ?)")
      .run(codeHash, expiresAt.getTime());
  }

  /**
   * Uses up a pairing code and pairs a device with the token's hash, in one transaction, so a
   * code can't pair twice. Returns false when the code is unknown, used or expired.
   */
  pair(codeHash: string, name: string, tokenHash: string, now: Date): boolean {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM pairing_codes WHERE expires_at <= ?").run(now.getTime());
      const used = this.db.prepare("DELETE FROM pairing_codes WHERE code_hash = ?").run(codeHash);
      if (used.changes === 0) return false;
      this.db
        .prepare("INSERT INTO devices (name, token_hash, paired_at) VALUES (?, ?, ?)")
        .run(name, tokenHash, now.getTime());
      return true;
    });
  }

  /** The device holding this token hash, if it is still paired. Notes when it was last seen. */
  deviceFor(tokenHash: string, now: Date): Device | undefined {
    const row = this.db
      .prepare("SELECT id, name, paired_at, last_seen_at FROM devices WHERE token_hash = ?")
      .get(tokenHash) as DeviceRow | undefined;
    if (!row) return undefined;
    if (row.last_seen_at === null || now.getTime() - row.last_seen_at >= LAST_SEEN_EVERY_MS) {
      this.db
        .prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
        .run(now.getTime(), row.id);
      row.last_seen_at = now.getTime();
    }
    return deviceOf(row);
  }

  devices(): Device[] {
    const rows = this.db
      .prepare("SELECT id, name, paired_at, last_seen_at FROM devices ORDER BY id")
      .all() as unknown as DeviceRow[];
    return rows.map(deviceOf);
  }

  /** Unpairs one device, or every device when `id` is undefined. Returns how many. */
  revoke(id?: number): number {
    const result =
      id === undefined
        ? this.db.prepare("DELETE FROM devices").run()
        : this.db.prepare("DELETE FROM devices WHERE id = ?").run(id);
    return Number(result.changes);
  }

  // --- Health data ---

  private paired(tokenHash: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM devices WHERE token_hash = ?").get(tokenHash);
    return row !== undefined;
  }

  /**
   * Applies one upload in a single transaction: records first, then deletions. With a token
   * hash, the device is checked again inside the transaction, so a device revoked while its
   * upload was arriving writes nothing. Returns false in that case.
   */
  apply(changes: Changes, now: Date, tokenHash?: string): boolean {
    if (!hasContent(changes)) return true;
    return this.transaction(() => {
      if (tokenHash !== undefined && !this.paired(tokenHash)) return false;
      const sample = this.db.prepare(
        `INSERT OR REPLACE INTO samples
           (id, type, start_ms, end_ms, number_value, text_value, unit, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of changes.samples) {
        sample.run(
          s.id,
          s.type,
          s.start.getTime(),
          s.end.getTime(),
          typeof s.value === "number" ? s.value : null,
          typeof s.value === "string" ? s.value : null,
          s.unit ?? null,
          s.source,
        );
      }
      const workout = this.db.prepare(
        `INSERT OR REPLACE INTO workouts
           (id, activity, start_ms, end_ms, duration_minutes,
            energy_value, energy_unit, distance_value, distance_unit, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const w of changes.workouts) {
        workout.run(
          w.id,
          w.activity,
          w.start.getTime(),
          w.end.getTime(),
          w.durationMinutes,
          w.energy?.value ?? null,
          w.energy?.unit ?? null,
          w.distance?.value ?? null,
          w.distance?.unit ?? null,
          w.source,
        );
      }
      const deleteSample = this.db.prepare("DELETE FROM samples WHERE id = ?");
      const deleteWorkout = this.db.prepare("DELETE FROM workouts WHERE id = ?");
      for (const id of changes.deleted) {
        deleteSample.run(id);
        deleteWorkout.run(id);
      }
      const clearDays = this.db.prepare(
        "DELETE FROM daily_stats WHERE type = ? AND statistic = ? AND day BETWEEN ? AND ?",
      );
      const day = this.db.prepare(
        "INSERT INTO daily_stats (type, statistic, day, value, unit) VALUES (?, ?, ?, ?, ?)",
      );
      for (const stats of changes.dailyStats) {
        clearDays.run(stats.type, stats.statistic, stats.from, stats.to);
        for (const v of stats.values) {
          day.run(stats.type, stats.statistic, v.day, v.value, stats.unit ?? null);
        }
      }
      const setCharacteristic = this.db.prepare(
        "INSERT OR REPLACE INTO characteristics (type, value) VALUES (?, ?)",
      );
      const clearCharacteristic = this.db.prepare("DELETE FROM characteristics WHERE type = ?");
      for (const [type, value] of changes.characteristics) {
        if (value === null) clearCharacteristic.run(type);
        else setCharacteristic.run(type, value);
      }
      if (changes.timeZone) this.saveSetting("timeZone", changes.timeZone);
      this.saveSetting("lastUploadAt", now.toISOString());
      return true;
    });
  }

  /**
   * Names this copy of the data. It changes when the data is erased, and a phone that sees a new
   * one sends its whole history again (docs/sync-protocol.md).
   */
  generation(): string {
    const current = this.setting("generation");
    if (current !== undefined) return current;
    const fresh = randomUUID();
    this.saveSetting("generation", fresh);
    return fresh;
  }

  /**
   * Deletes every copied Health record and starts a new generation; devices stay paired. With a
   * token hash, only a device that is still paired may do it (a phone starting over), and false
   * means it isn't. Throws when the deleted records can't be cleared out of the write-ahead log.
   */
  eraseHealthData(tokenHash?: string): boolean {
    const erased = this.transaction(() => {
      if (tokenHash !== undefined && !this.paired(tokenHash)) return false;
      this.db.exec(
        "DELETE FROM samples; DELETE FROM workouts; DELETE FROM daily_stats; DELETE FROM characteristics;",
      );
      const clear = this.db.prepare("DELETE FROM settings WHERE key = ?");
      for (const key of DATA_SETTINGS) clear.run(key);
      this.saveSetting("generation", randomUUID());
      return true;
    });
    if (!erased) return false;
    // Shrink the file, then empty the write-ahead log, which still holds the old pages. A reader
    // in the other process can keep the log busy for a moment, so this waits for it.
    this.db.exec("VACUUM");
    for (let attempt = 1; ; attempt++) {
      const { busy } = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {
        busy: number;
      };
      if (busy === 0) return true;
      if (attempt >= 20) {
        throw new Error(
          "The records are deleted, but the write-ahead log still holds copies. Run erase again, or stop the server first.",
        );
      }
      pause(250);
    }
  }

  /** Counts of stored records, for the admin's status command. */
  counts(): { samples: number; workouts: number; dailyStats: number; lastUploadAt?: string } {
    const count = (table: string) =>
      (this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
    const lastUploadAt = this.setting("lastUploadAt");
    return {
      samples: count("samples"),
      workouts: count("workouts"),
      dailyStats: count("daily_stats"),
      ...(lastUploadAt !== undefined && { lastUploadAt }),
    };
  }

  setting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  saveSetting(key: string, value: string): void {
    this.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
  }
}
