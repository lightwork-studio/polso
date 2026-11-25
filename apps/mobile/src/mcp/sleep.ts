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
  readonly inBedMinutes: number;
  /** Minutes per sleep stage, such as asleepCore, asleepDeep, asleepREM and awake. */
  readonly stages: Readonly<Record<string, number>>;
}

const ASLEEP = new Set(["asleepUnspecified", "asleepCore", "asleepDeep", "asleepREM"]);
const DETAILED = new Set(["asleepCore", "asleepDeep", "asleepREM"]);
const HALF_DAY = 12 * 60 * 60 * 1000;
const minutes = (r: SleepRecord) => (r.end.getTime() - r.start.getTime()) / 60_000;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Groups sleep records into nights. A record belongs to the night that starts on the local date
 * 12 hours before it ends, so sleep that ends at 7:00 counts for the evening before.
 *
 * Several sources (a watch and the phone, say) often record the same night, and adding them up
 * would count it twice. Each night therefore uses one source: the one with the most minutes of
 * detailed stages (core, deep, REM), then the one with the most minutes overall.
 */
export function summarizeNights(records: readonly SleepRecord[]): Night[] {
  const nights = new Map<string, Map<string, SleepRecord[]>>();
  for (const record of records) {
    const night = formatDay(new Date(record.end.getTime() - HALF_DAY));
    const bySource = nights.get(night) ?? new Map<string, SleepRecord[]>();
    bySource.set(record.source, [...(bySource.get(record.source) ?? []), record]);
    nights.set(night, bySource);
  }

  const score = (rs: SleepRecord[]) => {
    let detailed = 0;
    let total = 0;
    for (const r of rs) {
      total += minutes(r);
      if (DETAILED.has(r.stage)) detailed += minutes(r);
    }
    return [detailed, total] as const;
  };

  return [...nights.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([night, bySource]) => {
      const [source, chosen] = [...bySource.entries()].sort(([, a], [, b]) => {
        const [ad, at] = score(a);
        const [bd, bt] = score(b);
        return bd - ad || bt - at;
      })[0] as [string, SleepRecord[]];

      const stages: Record<string, number> = {};
      let asleep = 0;
      for (const r of chosen) {
        stages[r.stage] = (stages[r.stage] ?? 0) + minutes(r);
        if (ASLEEP.has(r.stage)) asleep += minutes(r);
      }
      const starts = chosen.map((r) => r.start.getTime());
      const ends = chosen.map((r) => r.end.getTime());
      return {
        night,
        source,
        bedtime: new Date(Math.min(...starts)).toISOString(),
        wakeTime: new Date(Math.max(...ends)).toISOString(),
        asleepMinutes: round(asleep),
        inBedMinutes: round(stages.inBed ?? 0),
        stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, round(v)])),
      };
    });
}
