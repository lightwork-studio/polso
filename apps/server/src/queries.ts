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
import type { Store } from "./store.ts";

/*
 * The MCP tools' reads, answered from the server's copy of the data instead of HealthKit, with
 * HealthKit's semantics: a record belongs to a time range when it overlaps it (it ends at or after
 * the start and starts before the end), and records come newest first by start time.
 *
 * Every records query is bounded on both sides of the start-time index: a record overlapping the
 * range starts before its end, and at most the type's longest record before its start. So a
 * question about one week years ago reads that week, not every record since.
 */

const SLEEP_ID = "HKCategoryTypeIdentifierSleepAnalysis";
const WORKOUT_ID = "HKWorkoutTypeIdentifier";

/** Records of a type overlapping [start, end), newest first by start. Exported for tests. */
export const SAMPLES_SQL = `SELECT start_ms, end_ms, number_value, text_value, unit, source
  FROM samples
  WHERE type = ? AND start_ms < ? AND start_ms >= ? AND end_ms >= ?
  ORDER BY start_ms DESC, id DESC LIMIT ?`;

/** Sleep records overlapping [start, end), oldest first, as the sleep summary expects. */
export const SLEEP_SQL = `SELECT start_ms, end_ms, number_value, text_value, source
  FROM samples
  WHERE type = ? AND start_ms < ? AND start_ms >= ? AND end_ms >= ?
  ORDER BY start_ms, id LIMIT ?`;

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
  /** The bounds for records of a type overlapping a range, in the order the queries take them. */
  const bounds = (type: string, range: { start: Date; end: Date }) => {
    const start = range.start.getTime();
    return [type, range.end.getTime(), start - store.maxSpan(type), start] as const;
  };

  return {
    async samples(type, range, limit): Promise<SampleRecord[]> {
      if (type.kind !== "quantity" && type.kind !== "category") {
        throw new Error(`${type.label} has no individual records to list.`);
      }
      const rows = db
        .prepare(SAMPLES_SQL)
        .all(...bounds(type.id, range), limit) as unknown as SampleRow[];
      return rows.map((row) => ({
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
        .all(type.id, statistic, localDay(range.start), localDay(range.end)) as unknown as {
        day: string;
        value: number;
      }[];
      return rows.map((row) => ({ day: startOf(row.day), value: row.value }));
    },

    async workouts(range, limit): Promise<WorkoutRecord[]> {
      // Workouts are few, so the longest is found on the spot.
      const longest =
        (
          db.prepare("SELECT max(end_ms - start_ms) AS span FROM workouts").get() as {
            span: number | null;
          }
        ).span ?? 0;
      const rows = db
        .prepare(
          `SELECT activity, start_ms, end_ms, duration_minutes, energy_value, energy_unit,
                  distance_value, distance_unit, source
           FROM workouts WHERE start_ms < ? AND start_ms >= ? AND end_ms >= ?
           ORDER BY start_ms DESC, id DESC LIMIT ?`,
        )
        .all(
          range.end.getTime(),
          range.start.getTime() - longest,
          range.start.getTime(),
          limit,
        ) as unknown as {
        activity: string;
        start_ms: number;
        end_ms: number;
        duration_minutes: number;
        energy_value: number | null;
        energy_unit: string | null;
        distance_value: number | null;
        distance_unit: string | null;
        source: string;
      }[];
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
      const rows = db
        .prepare(SLEEP_SQL)
        .all(...bounds(SLEEP_ID, range), limit) as unknown as SampleRow[];
      return rows.map((row) => ({
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
