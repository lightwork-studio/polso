import type { HealthType } from "@polso/mcp/health/catalog";
import { agentUnit } from "@polso/mcp/health/queries";
import type { DailyStatsUpload, SampleUpload, SyncClient, Upload, WorkoutUpload } from "./client";

/*
 * One sync run: sends what changed in HealthKit since the last run, type by type, in batches
 * (docs/sync-protocol.md). Each type's HealthKit anchor moves on only after the server accepted
 * the batch, so a run that stops partway (no network, iOS suspends Polso) resumes where it
 * stopped. A server that names a new data generation was erased; then everything is sent again.
 */

/** Records per upload: about 250 KB of JSON, well under proxies' and the server's limits. */
export const BATCH = 1_000;
/** Days of daily statistics sent again after deletions, whose days HealthKit doesn't name. */
export const RECENT_DAYS = 14;
/** At most this many days in one daily-statistics entry (the server takes 4,000). */
export const DAYS_PER_ENTRY = 3_000;

export interface Changes {
  readonly samples: readonly SampleUpload[];
  readonly workouts: readonly WorkoutUpload[];
  readonly deleted: readonly string[];
  /** Where to continue next time. */
  readonly anchor: string;
}

/** HealthKit, as sync needs it. */
export interface SyncSource {
  /** The types to send records of: quantity and category types, and workouts. */
  types(): Promise<readonly HealthType[]>;
  /** Up to `limit` changes of a type after `anchor` (all of them from the start without one). */
  changes(type: HealthType, anchor: string | undefined, limit: number): Promise<Changes>;
  /** HealthKit's daily statistic of a quantity type for each local day from `from` to `to`. */
  dailyStats(
    type: HealthType,
    statistic: DailyStatsUpload["statistic"],
    from: string,
    to: string,
  ): Promise<{ day: string; value: number }[]>;
  /** Profile values such as blood type; null for one that isn't set. */
  characteristics(): Promise<Record<string, string | null>>;
  timeZone(): string;
  /** The local day of a time, as YYYY-MM-DD. */
  dayOf(date: Date): string;
}

export interface SyncState {
  /** The server's data generation this state belongs to. */
  readonly generation?: string;
  /** Each type's HealthKit anchor, by type identifier. */
  readonly anchors: Readonly<Record<string, string>>;
  /**
   * Quantity types whose daily statistics are still owed for their whole history, from the
   * earliest day seen: sent after a type's first full pass, and kept until they are, so a run
   * that stops partway sends them next time.
   */
  readonly statsOwed?: Readonly<Record<string, string>>;
  readonly lastSyncAt?: string;
}

export interface StateStore {
  load(): Promise<SyncState>;
  save(state: SyncState): Promise<void>;
}

/** The statistics a quantity type has, as the MCP tool offers them. */
export const statisticsFor = (type: HealthType): DailyStatsUpload["statistic"][] =>
  type.aggregation === "cumulative" ? ["sum"] : ["average", "min", "max"];

const addDays = (day: string, days: number) => {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};

/** Splits [from, to] into ranges of at most DAYS_PER_ENTRY days. */
export function dayRanges(from: string, to: string): [string, string][] {
  const ranges: [string, string][] = [];
  for (let start = from; start <= to; start = addDays(start, DAYS_PER_ENTRY)) {
    const end = addDays(start, DAYS_PER_ENTRY - 1);
    ranges.push([start, end < to ? end : to]);
  }
  return ranges;
}

export interface SyncProgress {
  /** Records sent in this run so far. */
  readonly sent: number;
}

export class SyncEngine {
  constructor(
    private readonly source: SyncSource,
    private readonly client: SyncClient,
    private readonly store: StateStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Runs one sync. Throws a SyncError when the server can't be reached or refuses; whatever was
   * accepted before that stays accepted.
   */
  async run(onProgress?: (progress: SyncProgress) => void): Promise<void> {
    let state = await this.store.load();
    let sent = 0;
    const report = (records: number) => {
      sent += records;
      onProgress?.({ sent });
    };
    // A phone without a generation starts over: HealthKit can't tell it what was deleted while
    // it had no anchors, so the server's old copy goes first.
    if (!state.generation) {
      state = { generation: await this.client.reset(), anchors: {} };
      await this.store.save(state);
    }
    // At most one restart: an erase during this run makes the server name a new generation.
    for (let attempt = 0; attempt < 2; attempt++) {
      const restartWith = await this.pass(state, report);
      if (restartWith === undefined) {
        await this.store.save({
          ...(await this.store.load()),
          lastSyncAt: this.now().toISOString(),
        });
        return;
      }
      state = { generation: restartWith, anchors: {} };
      await this.store.save(state);
    }
  }

  /** Sends everything after the saved anchors. Returns a new generation if the server has one. */
  private async pass(
    initial: SyncState,
    report: (records: number) => void,
  ): Promise<string | undefined> {
    let state = initial;
    const save = async (next: SyncState) => {
      state = next;
      await this.store.save(state);
    };
    const send = (changes: Upload) =>
      this.client.upload({ timeZone: this.source.timeZone(), ...changes });

    const first = await send({ characteristics: await this.source.characteristics() });
    if (first !== state.generation) return first;

    for (const type of await this.source.types()) {
      const firstTime = state.anchors[type.id] === undefined;
      for (;;) {
        const changes = await this.source.changes(type, state.anchors[type.id], BATCH);
        const days = this.daysOf(changes);
        const count = changes.samples.length + changes.workouts.length + changes.deleted.length;
        // On a first pass a type's statistics go once, at the end, for its whole history.
        const dailyStats =
          !firstTime && type.kind === "quantity" && (days || changes.deleted.length > 0)
            ? await this.statsFor(type, this.statsRange(days, changes.deleted.length > 0))
            : [];
        if (count > 0 || dailyStats.length > 0) {
          const generation = await send({
            ...(changes.samples.length > 0 && { samples: changes.samples }),
            ...(changes.workouts.length > 0 && { workouts: changes.workouts }),
            ...(changes.deleted.length > 0 && { deleted: changes.deleted }),
            ...(dailyStats.length > 0 && { dailyStats }),
          });
          if (generation !== state.generation) return generation;
          report(changes.samples.length + changes.workouts.length);
        }
        let statsOwed = state.statsOwed;
        if (firstTime && type.kind === "quantity" && days) {
          const owed = statsOwed?.[type.id];
          if (owed === undefined || days[0] < owed)
            statsOwed = { ...statsOwed, [type.id]: days[0] };
        }
        await save({
          ...state,
          anchors: { ...state.anchors, [type.id]: changes.anchor },
          ...(statsOwed && { statsOwed }),
        });
        if (count < BATCH) break;
      }
      const owed = state.statsOwed?.[type.id];
      if (owed !== undefined) {
        const today = this.source.dayOf(this.now());
        // Sent in slices, so no upload holds more than a few thousand values.
        for (const entry of await this.statsFor(type, [owed, today])) {
          const generation = await send({ dailyStats: [entry] });
          if (generation !== state.generation) return generation;
        }
        const { [type.id]: _sent, ...rest } = state.statsOwed ?? {};
        await save({ ...state, statsOwed: rest });
      }
    }
    return undefined;
  }

  /** The local days a batch's records touch, as [first, last]. */
  private daysOf(changes: Changes): [string, string] | undefined {
    const times = [...changes.samples, ...changes.workouts].flatMap((r) => [r.start, r.end]);
    if (times.length === 0) return undefined;
    const days = times.map((t) => this.source.dayOf(new Date(t))).sort();
    return [days[0] as string, days[days.length - 1] as string];
  }

  /** The days to send statistics for: the batch's days, and the recent ones after deletions. */
  private statsRange(days: [string, string] | undefined, deleted: boolean): [string, string] {
    const today = this.source.dayOf(this.now());
    let [from, to] = days ?? [today, today];
    if (deleted) {
      const recent = addDays(today, -(RECENT_DAYS - 1));
      if (!days || recent < from) from = recent;
      if (!days || today > to) to = today;
    }
    return [from, to];
  }

  private async statsFor(type: HealthType, [from, to]: [string, string]) {
    const entries: DailyStatsUpload[] = [];
    for (const statistic of statisticsFor(type)) {
      for (const [start, end] of dayRanges(from, to)) {
        const values = await this.source.dailyStats(type, statistic, start, end);
        entries.push({
          type: type.id,
          statistic,
          ...(agentUnit(type) !== undefined && { unit: agentUnit(type) }),
          from: start,
          to: end,
          values,
        });
      }
    }
    return entries;
  }
}
