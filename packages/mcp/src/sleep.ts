import { formatDay } from "./health/format.ts";
import type { SleepRecord } from "./health/queries.ts";

export interface Night {
  /** The local date the night starts on, e.g. "2026-11-24" for the night into the 25th. */
  readonly night: string;
  /** The app or device whose records the night is built from. */
  readonly source: string;
  /** Start and end of the night's main block of sleep, leaving out naps. */
  readonly bedtime: string;
  readonly wakeTime: string;
  /** Every minute asleep from noon to noon, naps included. */
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

/** The night a time falls in: at or before local noon, it belongs to the previous evening. */
export function nightOf(end: Date): string {
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

/** A source with stages wins over one with more sleep only if it has at least this share of it. */
const DETAILED_SHARE = 0.8;
/** Records closer together than this belong to one block of sleep. */
const BLOCK_GAP_MS = 2 * 60 * 60_000;

type Ranked = { source: string; rs: SleepRecord[]; t: ReturnType<typeof totals> };

/**
 * The source a night is built from: among the sources with at least DETAILED_SHARE of the most
 * minutes asleep, the one with the most minutes of detailed stages, then asleep, then overall. So a
 * watch's stages win over a phone's rougher estimate of the same night, but half an hour from a
 * watch whose battery died doesn't beat a full night from a bed sensor.
 */
function chooseSource(sources: Ranked[]): Ranked {
  let mostAsleep = 0;
  for (const s of sources) mostAsleep = Math.max(mostAsleep, s.t.asleep);
  const candidates = sources.filter((s) => s.t.asleep >= mostAsleep * DETAILED_SHARE);
  candidates.sort(
    (a, b) => b.t.detailed - a.t.detailed || b.t.asleep - a.t.asleep || b.t.all - a.t.all,
  );
  return candidates[0] as Ranked;
}

/**
 * The main block of sleep: records merged where they're less than BLOCK_GAP_MS apart, and of those
 * blocks the one with the most minutes asleep, then the longest. Bedtime and wake time come from
 * it, so an afternoon nap doesn't move bedtime to 14:00.
 */
function mainBlock(records: readonly SleepRecord[]): { start: number; end: number } {
  type Block = { start: number; end: number; asleep: number };
  const blocks: Block[] = [];
  const sorted = [...records].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const r of sorted) {
    const [start, end] = [r.start.getTime(), r.end.getTime()];
    const asleep = ASLEEP.has(r.stage) ? minutes(r) : 0;
    const last = blocks[blocks.length - 1];
    if (last && start - last.end < BLOCK_GAP_MS) {
      last.end = Math.max(last.end, end);
      last.asleep += asleep;
    } else {
      blocks.push({ start, end, asleep });
    }
  }
  let best = blocks[0] as Block;
  for (const b of blocks) {
    const longer = b.end - b.start > best.end - best.start;
    if (b.asleep > best.asleep || (b.asleep === best.asleep && longer)) best = b;
  }
  return best;
}

/**
 * Groups sleep records into nights, keyed by `nightOf`, so sleep that ends at 7:00 counts for the
 * evening before.
 *
 * Several sources (a watch and the phone, say) often record the same night, and adding them up
 * would count it twice. Each night therefore uses one source (see chooseSource). Its minutes
 * include every record of the night, naps too; bedtime and wake time are those of the main block.
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
      const sources = [...bySource.entries()].map(([source, rs]) => ({
        source,
        rs,
        t: totals(rs),
      }));
      const chosen = chooseSource(sources);

      const stages: Record<string, number> = {};
      for (const r of chosen.rs) stages[r.stage] = (stages[r.stage] ?? 0) + minutes(r);
      let inBed = chosen.t.inBed;
      if (!inBed) for (const s of sources) inBed = Math.max(inBed, s.t.inBed);
      const block = mainBlock(chosen.rs);
      return {
        night,
        source: chosen.source,
        bedtime: new Date(block.start).toISOString(),
        wakeTime: new Date(block.end).toISOString(),
        asleepMinutes: round(chosen.t.asleep),
        inBedMinutes: inBed > 0 ? round(inBed) : null,
        stages: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, round(v)])),
      };
    });
}
