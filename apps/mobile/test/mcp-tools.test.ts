import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEALTH_TYPES, type HealthType } from "../src/health/catalog";
import type { HealthQueries } from "../src/health/queries";
import { summarizeNights } from "../src/mcp/sleep";
import {
  callTool,
  SLEEP_RECORD_LIMIT,
  shortName,
  type ToolContext,
  ToolInputError,
} from "../src/mcp/tools";

const now = new Date(2026, 10, 25, 12, 0);
const DAY = 24 * 60 * 60 * 1000;
const byShort = (name: string) => HEALTH_TYPES.find((t) => shortName(t.id) === name) as HealthType;

const queries = {
  samples: vi.fn<HealthQueries["samples"]>(async () => []),
  dailyStats: vi.fn<HealthQueries["dailyStats"]>(async () => []),
  workouts: vi.fn<HealthQueries["workouts"]>(async () => []),
  sleep: vi.fn<HealthQueries["sleep"]>(async () => []),
  characteristic: vi.fn<HealthQueries["characteristic"]>(async () => undefined),
};
const ctx: ToolContext = { types: HEALTH_TYPES, queries, now };
const run = (name: string, args: Record<string, unknown> = {}) =>
  callTool(name, args, ctx) as Promise<Record<string, unknown>>;

beforeEach(() => vi.clearAllMocks());

describe("list_health_types", () => {
  it("lists types by short name, with units agents read and the phone's time zone", async () => {
    const out = await run("list_health_types");
    const types = out.types as { type: string; unit?: string; aggregation?: string }[];
    expect(out.timeZone).toEqual(expect.any(String));
    expect(types.find((t) => t.type === "HeartRate")).toMatchObject({
      unit: "count/min",
      aggregation: "discrete",
      tools: ["get_latest", "get_samples", "get_daily_stats"],
    });
    expect(types.find((t) => t.type === "StepCount")).toMatchObject({ aggregation: "cumulative" });
    expect(types.find((t) => t.type === "SleepAnalysis")).toMatchObject({
      values: expect.arrayContaining(["asleepDeep", "inBed"]),
      tools: ["get_sleep", "get_latest", "get_samples"],
    });
  });

  it("lists only the types this phone has", async () => {
    const out = (await callTool(
      "list_health_types",
      {},
      {
        ...ctx,
        types: [byShort("StepCount")],
      },
    )) as { types: unknown[] };
    expect(out.types).toHaveLength(1);
  });

  it("filters by group and rejects unknown groups", async () => {
    const out = await run("list_health_types", { group: "Profile" });
    expect((out.types as { group: string }[]).every((t) => t.group === "Profile")).toBe(true);
    await expect(run("list_health_types", { group: "Secrets" })).rejects.toThrow(ToolInputError);
  });
});

describe("get_latest", () => {
  it("reads the newest record across all time", async () => {
    queries.samples.mockResolvedValueOnce([
      { start: now, end: now, value: 61, unit: "count/min", source: "Apple Watch" },
    ]);
    const out = await run("get_latest", { type: "restingheartrate" });
    expect(queries.samples).toHaveBeenCalledWith(
      byShort("RestingHeartRate"),
      { start: new Date(0), end: now },
      1,
    );
    expect(out).toEqual({
      type: "RestingHeartRate",
      latest: {
        start: now.toISOString(),
        end: now.toISOString(),
        value: 61,
        unit: "count/min",
        source: "Apple Watch",
      },
    });
  });

  it("says when there is nothing, and reads profile values", async () => {
    expect(await run("get_latest", { type: "StepCount" })).toEqual({
      type: "StepCount",
      latest: null,
    });
    queries.characteristic.mockResolvedValueOnce("O−");
    expect(await run("get_latest", { type: "BloodType" })).toEqual({
      type: "BloodType",
      value: "O−",
    });
  });

  it("accepts the full HealthKit identifier", async () => {
    await run("get_latest", { type: "HKQuantityTypeIdentifierStepCount" });
    expect(queries.samples.mock.calls[0]?.[0]).toBe(byShort("StepCount"));
  });
});

describe("get_samples", () => {
  it("defaults to the last 7 days and 100 records, and flags a full page", async () => {
    queries.samples.mockImplementationOnce(async (_t, _r, limit) =>
      Array.from({ length: limit }, () => ({ start: now, end: now, value: 1, source: "x" })),
    );
    const out = await run("get_samples", { type: "StepCount" });
    expect(queries.samples).toHaveBeenCalledWith(
      byShort("StepCount"),
      { start: new Date(now.getTime() - 7 * DAY), end: now },
      100,
    );
    expect(out.truncated).toBe(true);
  });

  it("reads a date-only end as the whole of that local day", async () => {
    await run("get_samples", { type: "StepCount", start: "2026-11-20", end: "2026-11-21" });
    const range = queries.samples.mock.calls[0]?.[1];
    expect(range?.start).toEqual(new Date(2026, 10, 20));
    expect(range?.end).toEqual(new Date(new Date(2026, 10, 22).getTime() - 1));
  });

  it.each([
    [{ type: "Nonsense" }, "Unknown type"],
    [{ type: "Workout" }, "use get_workouts"],
    [{ type: "StepCount", start: "yesterday" }, "ISO 8601"],
    [{ type: "StepCount", start: "" }, "ISO 8601"],
    [{ type: "StepCount", start: "2026-02-29" }, "ISO 8601"],
    [{ type: "StepCount", start: "2026-02-30T10:00:00Z" }, "ISO 8601"],
    [{ type: "StepCount", from: "2026-11-20" }, 'Unknown argument "from"'],
    [{ type: "StepCount", start: "2026-11-20T10:00:00Z", end: "2026-11-19T10:00:00Z" }, "before"],
    [{ type: "StepCount", limit: 5000 }, "1 to 1000"],
    [{ type: "StepCount", limit: "10" }, "1 to 1000"],
    [{ type: 42 }, "must be a string"],
  ])("rejects %j", async (args, message) => {
    await expect(run("get_samples", args)).rejects.toThrow(message);
    expect(queries.samples).not.toHaveBeenCalled();
  });
});

describe("get_daily_stats", () => {
  it("sums types that add up and dates each local day", async () => {
    queries.dailyStats.mockResolvedValueOnce([
      { day: new Date(2026, 10, 23), value: 8214 },
      { day: new Date(2026, 10, 24), value: 10_502 },
    ]);
    const out = await run("get_daily_stats", { type: "StepCount" });
    expect(queries.dailyStats.mock.calls[0]?.[2]).toBe("sum");
    expect(out).toEqual({
      type: "StepCount",
      statistic: "sum",
      unit: "count",
      days: [
        { date: "2026-11-23", value: 8214 },
        { date: "2026-11-24", value: 10_502 },
      ],
    });
  });

  it("averages types that don't add up, in per-minute units", async () => {
    const out = await run("get_daily_stats", { type: "HeartRate", statistic: "max" });
    expect(queries.dailyStats.mock.calls[0]?.[2]).toBe("max");
    expect(out).toMatchObject({ statistic: "max", unit: "count/min" });
    await run("get_daily_stats", { type: "HeartRate" });
    expect(queries.dailyStats.mock.calls[1]?.[2]).toBe("average");
  });

  it("includes the full first day and the current day's data so far by default", async () => {
    await run("get_daily_stats", { type: "StepCount" });
    expect(queries.dailyStats).toHaveBeenCalledWith(
      byShort("StepCount"),
      { start: new Date(2026, 10, 19), end: now },
      "sum",
    );
    await run("get_daily_stats", { type: "StepCount", start: "2026-11-22T14:00:00" });
    expect(queries.dailyStats.mock.calls[1]?.[1].start).toEqual(new Date(2026, 10, 22));
  });

  it("refuses statistics that don't fit the type, and ranges over a year", async () => {
    await expect(run("get_daily_stats", { type: "HeartRate", statistic: "sum" })).rejects.toThrow(
      "average, min or max",
    );
    await expect(run("get_daily_stats", { type: "StepCount", statistic: "max" })).rejects.toThrow(
      'only "sum"',
    );
    await expect(
      run("get_daily_stats", { type: "StepCount", start: "2024-01-01", end: "2026-01-01" }),
    ).rejects.toThrow("366 days");
    await expect(run("get_daily_stats", { type: "SleepAnalysis" })).rejects.toThrow(
      "use get_sleep",
    );
  });
});

describe("get_workouts and get_sleep", () => {
  it("caps workouts at 200", async () => {
    await expect(run("get_workouts", { limit: 201 })).rejects.toThrow("1 to 200");
    await run("get_workouts", {});
    expect(queries.workouts.mock.calls[0]?.[1]).toBe(50);
  });

  it("limits sleep to 92 days and summarizes by night", async () => {
    await expect(run("get_sleep", { start: "2026-01-01", end: "2026-11-01" })).rejects.toThrow(
      "92 nights",
    );
    queries.sleep.mockResolvedValueOnce([
      {
        start: new Date(2026, 10, 24, 23),
        end: new Date(2026, 10, 25, 6),
        stage: "asleepCore",
        source: "Watch",
      },
    ]);
    const out = await run("get_sleep");
    expect(out.nights).toMatchObject([{ night: "2026-11-24", asleepMinutes: 420 }]);
    expect(out.truncated).toBe(false);
    expect(queries.sleep).toHaveBeenCalledWith(
      { start: new Date(2026, 10, 18, 12), end: new Date(2026, 10, 25, 12) },
      SLEEP_RECORD_LIMIT,
    );
  });

  it("queries whole nights and, at the cap, leaves out the night the read cut off", async () => {
    const night = (day: number) => ({
      start: new Date(2026, 10, day, 23),
      end: new Date(2026, 10, day + 1, 7),
      stage: "asleepUnspecified",
      source: "Watch",
    });
    queries.sleep.mockImplementationOnce(async (_range, limit) => [
      ...Array(limit - 1).fill(night(23)),
      night(24),
    ]);
    const out = await run("get_sleep", { start: "2026-11-23", end: "2026-11-24" });
    expect(queries.sleep).toHaveBeenCalledWith(
      { start: new Date(2026, 10, 23, 12), end: new Date(2026, 10, 25, 12) },
      SLEEP_RECORD_LIMIT,
    );
    expect(out.truncated).toBe(true);
    expect((out.nights as { night: string }[]).map((n) => n.night)).toEqual(["2026-11-23"]);
  });

  it("leaves out sleep the read returns for nights outside the range", async () => {
    const rec = (start: Date, end: Date) => ({ start, end, stage: "asleepCore", source: "Watch" });
    queries.sleep.mockResolvedValueOnce([
      rec(new Date(2026, 10, 23, 10), new Date(2026, 10, 23, 12)), // ends the night before
      rec(new Date(2026, 10, 23, 23), new Date(2026, 10, 24, 7)),
      rec(new Date(2026, 10, 24, 11), new Date(2026, 10, 24, 12, 30)), // a late riser's next night
    ]);
    const out = await run("get_sleep", { start: "2026-11-23", end: "2026-11-23" });
    expect(out.nights).toMatchObject([{ night: "2026-11-23", asleepMinutes: 480 }]);
  });
});

describe("category values", () => {
  it("lists the value records carry for types without values of their own", async () => {
    const out = await run("list_health_types");
    const types = out.types as { type: string; values?: string[] }[];
    expect(types.find((t) => t.type === "MindfulSession")?.values).toEqual(["recorded"]);
  });
});

describe("nights", () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute);
  const rec = (stage: string, start: Date, end: Date, source = "Apple Watch") => ({
    start,
    end,
    stage,
    source,
  });

  it("counts a night once when the watch and the phone both recorded it", () => {
    const nights = summarizeNights([
      rec("inBed", at(24, 22, 30), at(25, 7), "iPhone"),
      rec("asleepUnspecified", at(24, 23), at(25, 6, 30), "iPhone"),
      rec("asleepCore", at(24, 23), at(25, 2), "Apple Watch"),
      rec("asleepDeep", at(25, 2), at(25, 3), "Apple Watch"),
      rec("awake", at(25, 3), at(25, 3, 10), "Apple Watch"),
      rec("asleepREM", at(25, 3, 10), at(25, 6, 40), "Apple Watch"),
    ]);
    expect(nights).toEqual([
      {
        night: "2026-11-24",
        source: "Apple Watch",
        bedtime: at(24, 23).toISOString(),
        wakeTime: at(25, 6, 40).toISOString(),
        asleepMinutes: 180 + 60 + 210,
        inBedMinutes: 510,
        stages: { asleepCore: 180, asleepDeep: 60, awake: 10, asleepREM: 210 },
      },
    ]);
  });

  it("files sleep ending in the morning under the evening before, and orders nights", () => {
    const nights = summarizeNights([
      rec("asleepCore", at(25, 23), at(26, 6)),
      rec("asleepCore", at(23, 23, 30), at(24, 7)),
      rec("asleepCore", at(24, 14), at(24, 14, 30)), // an afternoon nap
    ]);
    expect(nights.map((n) => n.night)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25"]);
  });

  it("falls back to the source with the most time when none has stages", () => {
    const nights = summarizeNights([
      rec("asleepUnspecified", at(24, 23), at(25, 5), "Sleep app"),
      rec("asleepUnspecified", at(24, 23), at(25, 7), "iPhone"),
    ]);
    expect(nights[0]).toMatchObject({ source: "iPhone", asleepMinutes: 480 });
  });

  it("keeps sleep from one source and uses time in bed from another when needed", () => {
    const nights = summarizeNights([
      rec("inBed", at(24, 20), at(25, 8), "iPhone"),
      rec("asleepUnspecified", at(24, 23), at(25, 6), "Watch"),
    ]);
    expect(nights[0]).toMatchObject({ source: "Watch", asleepMinutes: 420, inBedMinutes: 720 });
  });

  it("prefers a full night without stages over a watch that stopped early", () => {
    const nights = summarizeNights([
      rec("asleepCore", at(24, 23), at(24, 23, 30), "Watch"),
      rec("asleepUnspecified", at(24, 23), at(25, 7), "Bed sensor"),
    ]);
    expect(nights[0]).toMatchObject({ source: "Bed sensor", asleepMinutes: 480 });
  });

  it("prefers stages when that source has most of the sleep", () => {
    const nights = summarizeNights([
      rec("asleepCore", at(24, 23, 30), at(25, 6, 30), "Watch"),
      rec("asleepUnspecified", at(24, 23), at(25, 7), "Bed sensor"),
    ]);
    expect(nights[0]).toMatchObject({ source: "Watch", asleepMinutes: 420 });
  });

  it("takes bedtime and wake time from the main sleep and counts naps in the minutes", () => {
    const nights = summarizeNights([
      rec("asleepCore", at(24, 14), at(24, 14, 40)),
      rec("asleepCore", at(24, 23), at(25, 3)),
      rec("awake", at(25, 3), at(25, 3, 20)),
      rec("asleepCore", at(25, 4), at(25, 7)), // 40 minutes after waking: still the same block
      rec("asleepCore", at(25, 10), at(25, 11)),
    ]);
    expect(nights).toEqual([
      expect.objectContaining({
        night: "2026-11-24",
        bedtime: at(24, 23).toISOString(),
        wakeTime: at(25, 7).toISOString(),
        asleepMinutes: 40 + 240 + 180 + 60,
      }),
    ]);
  });

  it("assigns records ending at noon to the previous evening", () => {
    const nights = summarizeNights([rec("asleepCore", at(25, 11), at(25, 12))]);
    expect(nights[0]?.night).toBe("2026-11-24");
  });
});

describe("type names", () => {
  it("gives every type a short, unique name without HealthKit prefixes", () => {
    const names = HEALTH_TYPES.map((t) => shortName(t.id));
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((n) => n.startsWith("HK"))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(["Workout", "StepCount", "BloodPressure"]));
  });
});
