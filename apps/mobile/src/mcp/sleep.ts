import { formatDay } from "../health/format";
import type { SleepRecord } from "../health/queries";

export interface Night {
  /** The local date the night starts on, e.g. "2026-11-24" for the night into the 25th. */
  readonly night: string;
  /** The app or device whose records the night is built from. */
  readonly source: string;
  readonly bedtime: string;
  readonly wakeTime: string;
  readonly asleepMinutes: number;
  /** Time in bed, from the chosen source or else another one; null when none recorded it. */
  readonly inBedMinutes: number | null;
  /** Minutes per sleep stage, such as asleepCore, asleepDeep, asleepREM and awake. */
  readonly stages: Readonly<Record<string, number>>;
}

const ASLEEP = new Set(["asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM"]);
const DETAILED = new Set(["asleepCore", "asleepDeep", "asleepREM"]);
const minutes = (r: SleepRecord) => (r.end.getTime() - r.start.getTime()) / 60_000;
const round = (n: number) => Math.round(n * 10) / 10;

/** A record ending at or before local noon belongs to the previous evening. */
function nightOf(end: Date): string {
  const day = new Date(end);
  const noon = new Date(end);
  noon.setHours(12, 0, 0, 0);
  if (end <= noon) day.setDate(day.getDate() - 1);
  return formatDay(day);
}

function totals(records: readonly SleepRecord[]) {
  let detailed = 0;
  let asleep = 0;
  let inBed = 0;
  let all = 0;
  for (const r of records) {
    const m = minutes(r);
    all += m;
    if (DETAILED.has(r.stage)) detailed += m;
    if (ASLEEP.has(r.stage)) asleep += m;
    if (r.stage === "inBed") inBed += m;
  }
  return { detailed, asleep, inBed, all };
}

/**
 * Groups sleep records into nights, keyed by `nightOf`, so sleep that ends at 7:00 counts for the
 * evening before.
 *
 * Several sources (a watch and the phone, say) often record the same night, and adding them up
 * would count it twice. Each night therefore uses one source: the one with the most minutes of
 * detailed stages (core, deep, REM), then the most minutes asleep, then the most minutes overall.
 */
export function summarizeNights(records: readonly SleepRecord[]): Night[] {
  const nights = new Map<string, Map<string, SleepRecord[]>>();
  for (const record of records) {
    const night = nightOf(record.end);
    let bySource = nights.get(night);
    if (!bySource) {
      bySource = new Map();
      nights.set(night, bySource);
    }
    const list = bySource.get(record.source);
    if (list) list.push(record);
    else bySource.set(record.source, [record]);
  }

  return [...nights.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([night, bySource]) => {
      const ranked = [...bySource.entries()]
        .map(([source, rs]) => ({ source, rs, t: totals(rs) }))
        .sort(
          (a, b) => b.t.detailed - a.t.detailed || b.t.asleep - a.t.asleep || b.t.all - a.t.all,
        );
      const chosen = ranked[0] as (typeof ranked)[number];

      const stages: Record<string, number> = {};
      for (const r of chosen.rs) stages[r.stage] = (stages[r.stage] ?? 0) + minutes(r);
      const inBed = chosen.t.inBed || Math.max(0, ...ranked.map((s) => s.t.inBed));
      const starts = chosen.rs.map((r) => r.start.getTime());
      const ends = chosen.rs.map((r) => r.end.getTime());
      return {
        night,
        source: chosen.source,
        bedtime: new Date(Math.min(...starts)).toISOString(),
        wakeTime: new Date(Math.max(...ends)).toISOString(),
        asleepMinutes: round(chosen.t.asleep),
        inBedMinutes: inBed > 0 ? round(inBed) : null,
        stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, round(v)])),
      };
    });
}
