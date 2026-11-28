import { HEALTH_TYPES, type HealthType } from "@polso/mcp/health/catalog";
import type {
  DailyValue,
  HealthQueries,
  SampleRecord,
  SleepRecord,
  Statistic,
  WorkoutRecord,
} from "@polso/mcp/health/queries";
import type { ToolContext } from "@polso/mcp/tools";
import { LONG_RECORD_MS, type Store } from "./store.ts";

/*
 * The MCP tools' reads, answered from the server's copy of the data instead of HealthKit, with
 * HealthKit's semantics: a record belongs to a time range when it overlaps it (it ends at or after
 * the start and starts before the end), and records come newest first by start time.
 *
 * Records queries read the start-time index between the range's end and two days
 * (LONG_RECORD_MS) before its start: a record overlapping the range starts in there unless it's
 * longer than two days. The rare longer records come from a partial index of their own and are
 * merged in. So a query reads the records it returns, the records starting in the two days
 * before the range, and the type's records over two days long that start before the range's
 * end; never every record since, whatever any one record's length. (Someone who can upload, a
 * paired phone, can still add load by uploading masses of records; that's within what it's
 * trusted with.) Ties on start time go by rowid, which the index already holds, so no query
 * sorts.
 */

const SLEEP_ID = "HKCategoryTypeIdentifierSleepAnalysis";
const WORKOUT_ID = "HKWorkoutTypeIdentifier";

const COLUMNS = "rowid AS row_id, start_ms, end_ms, number_value, text_value, unit, source";
// The partial index's condition, repeated word for word so SQLite uses the index.
const LONG = `end_ms - start_ms > ${LONG_RECORD_MS}`;

/** Records of a type overlapping [start, end) that start at most two days before it. */
export const SAMPLES_SQL = `SELECT ${COLUMNS} FROM samples
  WHERE type = ? AND start_ms < ? AND start_ms >= ? AND end_ms >= ?
  ORDER BY start_ms DESC, rowid DESC LIMIT ?`;

/** The same, oldest first, as the sleep summary expects. */
export const SLEEP_SQL = `SELECT ${COLUMNS} FROM samples
  WHERE type = ? AND start_ms < ? AND start_ms >= ? AND end_ms >= ?
  ORDER BY start_ms, rowid LIMIT ?`;

/** Records longer than two days overlapping [start, end), from their own index. */
export const LONG_SQL = `SELECT ${COLUMNS} FROM samples
  WHERE type = ? AND ${LONG} AND start_ms < ? AND end_ms >= ?
  ORDER BY start_ms DESC, rowid DESC LIMIT ?`;
export const LONG_SLEEP_SQL = `SELECT ${COLUMNS} FROM samples
  WHERE type = ? AND ${LONG} AND start_ms < ? AND end_ms >= ?
  ORDER BY start_ms, rowid LIMIT ?`;

const WORKOUT_COLUMNS = `rowid AS row_id, activity, start_ms, end_ms, duration_minutes,
  energy_value, energy_unit, distance_value, distance_unit, source`;
/** Workouts overlapping [start, end), newest first: the usual ones, then the long ones. */
export const WORKOUTS_SQL = `SELECT ${WORKOUT_COLUMNS} FROM workouts
  WHERE start_ms < ? AND start_ms >= ? AND end_ms >= ?
  ORDER BY start_ms DESC, rowid DESC LIMIT ?`;
export const LONG_WORKOUTS_SQL = `SELECT ${WORKOUT_COLUMNS} FROM workouts
  WHERE ${LONG} AND start_ms < ? AND end_ms >= ?
  ORDER BY start_ms DESC, rowid DESC LIMIT ?`;

/**
 * Merges the usual and the long rows of a range, each already in order and cut to `limit`:
 * without duplicates, in order (start time, then rowid), cut to `limit`.
 */
function merge<Row extends { row_id: number; start_ms: number }>(
  usual: Row[],
  long: Row[],
  order: "newest" | "oldest",
  limit: number,
): Row[] {
  if (long.length === 0) return usual;
  const byRow = new Map(usual.map((row) => [row.row_id, row]));
  for (const row of long) byRow.set(row.row_id, row);
  const sign = order === "newest" ? -1 : 1;
  return [...byRow.values()]
    .sort((a, b) => sign * (a.start_ms - b.start_ms || a.row_id - b.row_id))
    .slice(0, limit);
}

const pad = (n: number) => String(n).padStart(2, "0");
/** The local calendar day of a time, as YYYY-MM-DD, in the process's time zone. */
const localDay = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** Local midnight that starts a YYYY-MM-DD day. */
const startOf = (day: string) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};

/**
 * The tools work in local days (today, last night), and a phone's days are its own time zone's.
 * The server serves one person, so it adopts the zone the phone last sent, process-wide, by its
 * canonical name (TZ doesn't understand "europe/berlin"). Node applies a change to TZ at once.
 */
export function adoptTimeZone(zone: string | undefined): void {
  if (!zone) return;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
  } catch {
    return; // A zone this Node doesn't know: keep the current one rather than fall back to UTC.
  }
  if (process.env.TZ !== canonical) process.env.TZ = canonical;
}

interface SampleRow {
  row_id: number;
  start_ms: number;
  end_ms: number;
  number_value: number | null;
  text_value: string | null;
  unit: string | null;
  source: string;
}

const recordValue = (row: { number_value: number | null; text_value: string | null }) =>
  row.text_value ?? row.number_value ?? "";

export function storeQueries(store: Store): HealthQueries {
  const db = store.db;
  /**
   * Records of a type overlapping a range, newest or oldest first by start: the usual ones plus
   * the long ones, without duplicates, cut to `limit`.
   */
  const records = (
    type: string,
    range: { start: Date; end: Date },
    limit: number,
    order: "newest" | "oldest",
  ): SampleRow[] => {
    const start = range.start.getTime();
    const end = range.end.getTime();
    const [usualSql, longSql] =
      order === "newest" ? [SAMPLES_SQL, LONG_SQL] : [SLEEP_SQL, LONG_SLEEP_SQL];
    const usual = db
      .prepare(usualSql)
      .all(type, end, start - LONG_RECORD_MS, start, limit) as unknown as SampleRow[];
    const long = db.prepare(longSql).all(type, end, start, limit) as unknown as SampleRow[];
    return merge(usual, long, order, limit);
  };

  return {
    async samples(type, range, limit): Promise<SampleRecord[]> {
      if (type.kind !== "quantity" && type.kind !== "category") {
        throw new Error(`${type.label} has no individual records to list.`);
      }
      return records(type.id, range, limit, "newest").map((row) => ({
        start: new Date(row.start_ms),
        end: new Date(row.end_ms),
        value: recordValue(row),
        ...(row.unit !== null && { unit: row.unit }),
        source: row.source,
      }));
    },

    async dailyStats(type, range, statistic: Statistic): Promise<DailyValue[]> {
      const rows = db
        .prepare(
          `SELECT day, value FROM daily_stats
           WHERE type = ? AND statistic = ? AND day BETWEEN ? AND ?
           ORDER BY day`,
        )
        // The range's end is exclusive, as on the phone: an end at midnight takes no part of
        // the day it starts.
        .all(
          type.id,
          statistic,
          localDay(range.start),
          localDay(new Date(range.end.getTime() - 1)),
        ) as unknown as {
        day: string;
        value: number;
      }[];
      return rows.map((row) => ({ day: startOf(row.day), value: row.value }));
    },

    async workouts(range, limit): Promise<WorkoutRecord[]> {
      const start = range.start.getTime();
      const end = range.end.getTime();
      type WorkoutRow = {
        row_id: number;
        activity: string;
        start_ms: number;
        end_ms: number;
        duration_minutes: number;
        energy_value: number | null;
        energy_unit: string | null;
        distance_value: number | null;
        distance_unit: string | null;
        source: string;
      };
      const usual = db
        .prepare(WORKOUTS_SQL)
        .all(end, start - LONG_RECORD_MS, start, limit) as unknown as WorkoutRow[];
      const long = db.prepare(LONG_WORKOUTS_SQL).all(end, start, limit) as unknown as WorkoutRow[];
      const rows = merge(usual, long, "newest", limit);
      return rows.map((row) => ({
        activity: row.activity,
        start: new Date(row.start_ms),
        end: new Date(row.end_ms),
        durationMinutes: row.duration_minutes,
        ...(row.energy_value !== null &&
          row.energy_unit !== null && {
            energy: { value: row.energy_value, unit: row.energy_unit },
          }),
        ...(row.distance_value !== null &&
          row.distance_unit !== null && {
            distance: { value: row.distance_value, unit: row.distance_unit },
          }),
        source: row.source,
      }));
    },

    async sleep(range, limit): Promise<SleepRecord[]> {
      return records(SLEEP_ID, range, limit, "oldest").map((row) => ({
        start: new Date(row.start_ms),
        end: new Date(row.end_ms),
        // As on the phone: a stage without a name is reported by its number.
        stage: String(recordValue(row)),
        source: row.source,
      }));
    },

    async characteristic(type) {
      const row = db.prepare("SELECT value FROM characteristics WHERE type = ?").get(type.id) as
        | { value: string }
        | undefined;
      return row?.value;
    },
  };
}

/**
 * The catalog's types that the server holds any data for: what list_health_types offers. One
 * indexed lookup per type, rather than reading every record's type.
 */
export function storedTypes(store: Store): HealthType[] {
  const db = store.db;
  const inSamples = db.prepare("SELECT 1 FROM samples WHERE type = ? LIMIT 1");
  const inStats = db.prepare("SELECT 1 FROM daily_stats WHERE type = ? LIMIT 1");
  const inProfile = db.prepare("SELECT 1 FROM characteristics WHERE type = ?");
  const hasWorkouts = db.prepare("SELECT 1 FROM workouts LIMIT 1").get() !== undefined;
  return HEALTH_TYPES.filter((type) => {
    switch (type.kind) {
      case "quantity":
        return inSamples.get(type.id) !== undefined || inStats.get(type.id) !== undefined;
      case "category":
        return inSamples.get(type.id) !== undefined;
      case "characteristic":
        return inProfile.get(type.id) !== undefined;
      case "workout":
        return type.id === WORKOUT_ID && hasWorkouts;
      default:
        return false;
    }
  });
}

// Listing stored types takes a lookup per catalog type, so it's kept until the data changes.
const typesCache = new WeakMap<Store, { key: string; types: HealthType[] }>();

/** The context each MCP request runs in: the stored data, in the phone's time zone. */
export function toolContext(store: Store): ToolContext {
  adoptTimeZone(store.setting("timeZone"));
  const key = `${store.generation()} ${store.setting("lastUploadAt") ?? ""}`;
  let cached = typesCache.get(store);
  if (cached?.key !== key) {
    cached = { key, types: storedTypes(store) };
    typesCache.set(store, cached);
  }
  return { types: cached.types, queries: storeQueries(store), now: new Date() };
}
