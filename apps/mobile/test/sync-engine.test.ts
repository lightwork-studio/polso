import type { HealthType } from "@polso/mcp/health/catalog";
import { beforeEach, describe, expect, it } from "vitest";
import { type SampleUpload, type SyncClient, SyncError, type Upload } from "../src/sync/client";
import {
  BATCH,
  type Changes,
  DAYS_PER_ENTRY,
  DELETIONS_PER_UPLOAD,
  dayRanges,
  RECENT_DAYS,
  SyncEngine,
  type SyncSource,
  type SyncState,
} from "../src/sync/engine";

const STEPS: HealthType = {
  id: "HKQuantityTypeIdentifierStepCount",
  kind: "quantity",
  label: "Steps",
  unit: "count",
  aggregation: "cumulative",
};
const HEART: HealthType = {
  id: "HKQuantityTypeIdentifierHeartRate",
  kind: "quantity",
  label: "Heart rate",
  unit: "count/s",
  aggregation: "discrete",
};
const SLEEP: HealthType = {
  id: "HKCategoryTypeIdentifierSleepAnalysis",
  kind: "category",
  label: "Sleep",
};

const sample = (n: number, type: HealthType, day: string): SampleUpload => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  type: type.id,
  start: `${day}T08:00:00.000Z`,
  end: `${day}T08:00:00.000Z`,
  value: n,
  source: "Watch",
});

/** HealthKit with a log of changes per type; an anchor is the count already read. */
class FakeHealth implements SyncSource {
  log = new Map<string, { samples: SampleUpload[]; deleted: string[] }[]>();
  statsCalls: [string, string, string, string][] = [];
  typeList: HealthType[] = [STEPS, SLEEP];

  add(type: HealthType, samples: SampleUpload[], deleted: string[] = []) {
    const entries = this.log.get(type.id) ?? [];
    for (const s of samples) entries.push({ samples: [s], deleted: [] });
    for (const d of deleted) entries.push({ samples: [], deleted: [d] });
    this.log.set(type.id, entries);
  }
  async types() {
    return this.typeList;
  }
  async changes(type: HealthType, anchor: string | undefined, limit: number): Promise<Changes> {
    const entries = this.log.get(type.id) ?? [];
    const from = anchor === undefined ? 0 : Number(anchor);
    const slice = entries.slice(from, from + limit);
    return {
      samples: slice.flatMap((e) => e.samples),
      workouts: [],
      deleted: slice.flatMap((e) => e.deleted),
      anchor: String(from + slice.length),
    };
  }
  async dailyStats(type: HealthType, statistic: string, from: string, to: string) {
    this.statsCalls.push([type.id, statistic, from, to]);
    return [{ day: to, value: 1 }];
  }
  async characteristics() {
    return { HKCharacteristicTypeIdentifierBloodType: "A+" };
  }
  timeZone = () => "Europe/Berlin";
  dayOf = (date: Date) => date.toISOString().slice(0, 10);
}

/** A server that records uploads, with a generation that erasing changes. */
class FakeServer {
  generation = "g1";
  uploads: Upload[] = [];
  resets = 0;
  failAfter?: number;
  ids = new Set<string>();
  client: SyncClient = {
    pair: async () => "token",
    upload: async (changes: Upload) => {
      if (this.failAfter !== undefined && this.uploads.length >= this.failAfter) {
        throw new SyncError("unavailable", "offline");
      }
      this.uploads.push(changes);
      for (const s of changes.samples ?? []) this.ids.add(s.id);
      for (const d of changes.deleted ?? []) this.ids.delete(d);
      return this.generation;
    },
    reset: async () => {
      this.resets++;
      this.ids.clear();
      this.generation = `g${Number(this.generation.slice(1)) + 1}`;
      return this.generation;
    },
  };
}

class MemoryState {
  state: SyncState = { anchors: {} };
  async load() {
    return this.state;
  }
  async save(state: SyncState) {
    this.state = state;
  }
}

const NOW = new Date("2026-11-27T12:00:00.000Z");
let health: FakeHealth;
let server: FakeServer;
let store: MemoryState;
const engine = () => new SyncEngine(health, server.client, store, () => NOW);

beforeEach(() => {
  health = new FakeHealth();
  server = new FakeServer();
  store = new MemoryState();
});

describe("sync engine", () => {
  it("starts over on a server it has no generation for, then sends everything", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20"), sample(2, STEPS, "2026-11-25")]);
    health.add(SLEEP, [sample(3, SLEEP, "2026-11-26")]);
    await engine().run();
    expect(server.resets).toBe(1);
    expect(store.state.generation).toBe("g2");
    expect([...server.ids].sort()).toEqual([
      sample(1, STEPS, "x").id,
      sample(2, STEPS, "x").id,
      sample(3, SLEEP, "x").id,
    ]);
    expect(server.uploads[0]).toMatchObject({
      timeZone: "Europe/Berlin",
      characteristics: { HKCharacteristicTypeIdentifierBloodType: "A+" },
    });
    expect(store.state.anchors).toEqual({ [STEPS.id]: "2", [SLEEP.id]: "1" });
    expect(store.state.lastSyncAt).toBe(NOW.toISOString());
  });

  it("sends a type's daily statistics for its whole history after its first pass", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-25"), sample(2, STEPS, "2019-03-01")]);
    await engine().run();
    expect(health.statsCalls).toEqual(
      dayRanges("2019-03-01", "2026-11-27").map(([from, to]) => [STEPS.id, "sum", from, to]),
    );
    const stats = server.uploads.flatMap((u) => u.dailyStats ?? []);
    expect(stats.every((s) => s.type === STEPS.id && s.unit === "count")).toBe(true);
    expect(store.state.statsOwed).toEqual({});
  });

  it("sends average, minimum and maximum for discrete types, in agents' units", async () => {
    health.typeList = [HEART];
    health.add(HEART, [sample(1, HEART, "2026-11-26")]);
    await engine().run();
    expect(health.statsCalls.map((c) => c[1])).toEqual(["average", "min", "max"]);
    const units = server.uploads.flatMap((u) => u.dailyStats ?? []).map((s) => s.unit);
    expect(new Set(units)).toEqual(new Set(["count/min"]));
  });

  it("sends only what changed next time, with the changed days' statistics", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    await engine().run();
    server.uploads = [];
    health.statsCalls = [];
    health.add(STEPS, [sample(2, STEPS, "2026-11-26")]);
    await engine().run();
    expect(server.resets).toBe(1);
    const sent = server.uploads.flatMap((u) => u.samples ?? []).map((s) => s.id);
    expect(sent).toEqual([sample(2, STEPS, "x").id]);
    expect(health.statsCalls).toEqual([[STEPS.id, "sum", "2026-11-26", "2026-11-26"]]);
  });

  it("passes deletions on, with the recent days' statistics", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    await engine().run();
    health.statsCalls = [];
    health.add(STEPS, [], [sample(1, STEPS, "x").id]);
    await engine().run();
    expect(server.ids.size).toBe(0);
    const from = new Date(NOW.getTime() - (RECENT_DAYS - 1) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(health.statsCalls).toEqual([[STEPS.id, "sum", from, "2026-11-27"]]);
  });

  it("sends in batches, and resumes after the last accepted batch", async () => {
    health.typeList = [SLEEP];
    health.add(
      SLEEP,
      Array.from({ length: BATCH * 2 + 5 }, (_, i) => sample(i, SLEEP, "2026-11-20")),
    );
    // Reset, characteristics, then one batch go through; the second batch fails.
    server.failAfter = 2;
    await expect(engine().run()).rejects.toThrow("offline");
    expect(store.state.anchors[SLEEP.id]).toBe(String(BATCH));
    expect(server.ids.size).toBe(BATCH);
    server.failAfter = undefined;
    await engine().run();
    expect(server.ids.size).toBe(BATCH * 2 + 5);
    expect(server.uploads.every((u) => (u.samples?.length ?? 0) <= BATCH)).toBe(true);
    expect(server.resets).toBe(1);
  });

  it("keeps owed statistics across a run that stops before sending them", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    // Reset, characteristics and the steps batch go through; the statistics don't.
    server.failAfter = 2;
    await expect(engine().run()).rejects.toThrow();
    expect(store.state.statsOwed).toEqual({ [STEPS.id]: "2026-11-20" });
    server.failAfter = undefined;
    health.statsCalls = [];
    await engine().run();
    expect(health.statsCalls).toEqual([[STEPS.id, "sum", "2026-11-20", "2026-11-27"]]);
    expect(store.state.statsOwed).toEqual({});
  });

  it("sends everything again when the server names a new generation", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    await engine().run();
    // The operator erased the server.
    await server.client.reset();
    server.resets = 0;
    await engine().run();
    expect(server.resets).toBe(0);
    expect(server.ids.has(sample(1, STEPS, "x").id)).toBe(true);
    expect(store.state.generation).toBe(server.generation);
  });
});

describe("trouble", () => {
  it("skips a type the server refuses, keeps its place, and sends the others", async () => {
    health.typeList = [STEPS, SLEEP];
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    health.add(SLEEP, [sample(2, SLEEP, "2026-11-20")]);
    const upload = server.client.upload;
    server.client.upload = async (changes, signal) => {
      if (changes.samples?.some((s) => s.type === STEPS.id)) {
        throw new SyncError("refused", "The server said: no.");
      }
      return upload(changes, signal);
    };
    const result = await engine().run();
    expect(result.failed).toEqual([{ label: "Steps", message: "The server said: no." }]);
    expect(store.state.anchors[STEPS.id]).toBeUndefined();
    expect(server.ids.has(sample(2, SLEEP, "x").id)).toBe(true);
    expect(store.state.lastSyncAt).toBe(NOW.toISOString());
  });

  it("stops the whole run when the server can't be reached", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    health.add(SLEEP, [sample(2, SLEEP, "2026-11-20")]);
    server.failAfter = 1;
    await expect(engine().run()).rejects.toMatchObject({ kind: "unavailable" });
    expect(store.state.anchors).toEqual({});
  });

  it("sends many deletions in several uploads", async () => {
    health.typeList = [SLEEP];
    health.add(
      SLEEP,
      [],
      Array.from({ length: 12_000 }, (_, i) => `gone-${i}`),
    );
    // HealthKit may hand over more deletions than the batch size in one go.
    const changes = health.changes.bind(health);
    health.changes = async (type, anchor) => changes(type, anchor, 20_000);
    await engine().run();
    const counts = server.uploads.map((u) => u.deleted?.length ?? 0).filter((n) => n > 0);
    expect(counts).toEqual([DELETIONS_PER_UPLOAD, DELETIONS_PER_UPLOAD, 2_000]);
  });

  it("sends a batch's daily statistics in uploads of their own", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    await engine().run();
    server.uploads = [];
    health.add(STEPS, [sample(2, STEPS, "2026-11-26")]);
    await engine().run();
    expect(server.uploads.some((u) => u.samples && u.dailyStats)).toBe(false);
    expect(server.uploads.some((u) => u.dailyStats)).toBe(true);
  });

  it("gives up, saying so, when the generation keeps changing", async () => {
    health.add(STEPS, [sample(1, STEPS, "2026-11-20")]);
    let n = 0;
    server.client.upload = async () => `g-changing-${n++}`;
    await expect(engine().run()).rejects.toThrow("kept changing");
  });

  it("works out days for any year", () => {
    expect(dayRanges("0050-01-01", "0050-01-03")).toEqual([["0050-01-01", "0050-01-03"]]);
  });
});

describe("an erase during a run", () => {
  it("starts over and sends everything when the generation changes between batches", async () => {
    health.typeList = [SLEEP];
    const count = BATCH + 10;
    health.add(
      SLEEP,
      Array.from({ length: count }, (_, i) => sample(i, SLEEP, "2026-11-20")),
    );
    // The operator erases the server right after the first batch arrives.
    const upload = server.client.upload;
    let erased = false;
    server.client.upload = async (changes) => {
      const generation = await upload(changes);
      if (!erased && (changes.samples?.length ?? 0) === BATCH) {
        erased = true;
        server.ids.clear();
        server.generation = "g-erased";
      }
      return generation;
    };
    await engine().run();
    expect(store.state.generation).toBe("g-erased");
    expect(server.ids.size).toBe(count);
  });
});

describe("day ranges", () => {
  it("splits long ranges into entries the server takes", () => {
    const ranges = dayRanges("2010-01-01", "2026-11-27");
    expect(ranges[0]?.[0]).toBe("2010-01-01");
    expect(ranges.at(-1)?.[1]).toBe("2026-11-27");
    for (const [from, to] of ranges) {
      const days = (Date.parse(to) - Date.parse(from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(DAYS_PER_ENTRY);
    }
    expect(dayRanges("2026-11-27", "2026-11-27")).toEqual([["2026-11-27", "2026-11-27"]]);
  });
});
