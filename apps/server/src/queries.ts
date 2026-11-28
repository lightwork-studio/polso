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
 * The MCP tools' reads, answered from the server's copy of the data instead of HealthKit. The
 * results match what the phone's own endpoint returns for the same records.
 */

const SLEEP_ID = "HKCategoryTypeIdentifierSleepAnalysis";
const WORKOUT_ID = "HKWorkoutTypeIdentifier";

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
 * The server serves one person, so it adopts the zone the phone last sent, process-wide. Node
 * applies a change to TZ at once.
 */
export function adoptTimeZone(zone: string | undefined): void {
  if (!zone || process.env.TZ === zone) return;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
  } catch {
    return; // A zone this Node doesn't know: keep the current one rather than fall back to UTC.
  }
  process.env.TZ = zone;
}

interface SampleRow {
  start_ms: number;
  end_ms: number;
  number_value: number | null;
  text_value: string | null;
  unit: string | null;
  source: string;
}

export function storeQueries(store: Store): HealthQueries {
  const db = store.db;
  return {
    async samples(type, range, limit): Promise<SampleRecord[]> {
      if (type.kind !== "quantity" && type.kind !== "category") {
        throw new Error(`${type.label} has no individual records to list.`);
      }
      const rows = db
        .prepare(
          `SELECT start_ms, end_ms, number_value, text_value, unit, source FROM samples
           WHERE type = ? AND end_ms >= ? AND start_ms <= ?
           ORDER BY end_ms DESC LIMIT ?`,
        )
        .all(type.id, range.start.getTime(), range.end.getTime(), limit) as unknown as SampleRow[];
      return rows.map((row) => ({
        start: new Date(row.start_ms),
        end: new Date(row.end_ms),
        value: row.number_value ?? row.text_value ?? "",
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
      const rows = db
        .prepare(
          `SELECT activity, start_ms, end_ms, duration_minutes, energy_value, energy_unit,
                  distance_value, distance_unit, source
           FROM workouts WHERE end_ms >= ? AND start_ms <= ?
           ORDER BY end_ms DESC LIMIT ?`,
        )
        .all(range.start.getTime(), range.end.getTime(), limit) as unknown as {
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
        .prepare(
          `SELECT start_ms, end_ms, text_value, source FROM samples
           WHERE type = ? AND end_ms >= ? AND start_ms <= ?
           ORDER BY start_ms LIMIT ?`,
        )
        .all(SLEEP_ID, range.start.getTime(), range.end.getTime(), limit) as unknown as {
        start_ms: number;
        end_ms: number;
        text_value: string | null;
        source: string;
      }[];
      return rows.map((row) => ({
        start: new Date(row.start_ms),
        end: new Date(row.end_ms),
        stage: row.text_value ?? "unknown",
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

/** The catalog's types that the server holds any data for: what list_health_types offers. */
export function storedTypes(store: Store): HealthType[] {
  const ids = new Set(
    (
      store.db
        .prepare(
          `SELECT DISTINCT type FROM samples
           UNION SELECT DISTINCT type FROM daily_stats
           UNION SELECT type FROM characteristics`,
        )
        .all() as { type: string }[]
    ).map((row) => row.type),
  );
  if (store.db.prepare("SELECT 1 FROM workouts LIMIT 1").get()) ids.add(WORKOUT_ID);
  return HEALTH_TYPES.filter((type) => ids.has(type.id));
}

// Listing stored types reads every sample's type, so it's kept until the data changes.
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
