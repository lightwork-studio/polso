import {
  queryCategorySamplesWithAnchor,
  queryQuantitySamplesWithAnchor,
  queryWorkoutSamplesWithAnchor,
} from "@kingstinct/react-native-healthkit";
import { HEALTH_TYPES, type HealthType } from "@polso/mcp/health/catalog";
import { describe, expect, it, vi } from "vitest";
import { parseChanges } from "../../server/src/changes";
import { healthKitSync } from "../src/health/healthkit";
import type { SyncClient, Upload } from "../src/sync/client";
import { SyncEngine } from "../src/sync/engine";

/*
 * The phone's uploads against the server's own check (apps/server/src/changes.ts): whatever
 * HealthKit hands over, as mapped by the adapter and batched by the engine, the server accepts.
 */

const type = (id: string) => HEALTH_TYPES.find((t) => t.id === id) as HealthType;
const STEPS = type("HKQuantityTypeIdentifierStepCount");
const HEART = type("HKQuantityTypeIdentifierHeartRate");
const SLEEP = type("HKCategoryTypeIdentifierSleepAnalysis");
const WORKOUT = type("HKWorkoutTypeIdentifier");
const source = (name: string) => ({ sourceRevision: { source: { name } } });
const at = (iso: string) => new Date(iso);

describe("what the phone sends, the server accepts", () => {
  it("accepts records as the HealthKit adapter shapes them, odd ones included", async () => {
    vi.mocked(queryQuantitySamplesWithAnchor).mockResolvedValueOnce({
      samples: [
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000001",
          startDate: at("2026-11-27T07:00:00Z"),
          endDate: at("2026-11-27T07:01:00Z"),
          quantity: 1.05,
          unit: "count/min",
          ...source(""), // An app without a name.
        },
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000002",
          startDate: at("0999-03-01T00:00:00Z"), // Some apps write nonsense dates.
          endDate: at("0999-03-01T00:00:00Z"),
          quantity: 60,
          unit: "count/min",
          ...source("x".repeat(500)),
        },
      ],
      deletedSamples: [{ uuid: "1F0E2A3B-0000-4000-8000-000000000003" }],
      newAnchor: "a2",
    } as never);
    const quantity = await healthKitSync.changes(HEART, undefined, 1000);

    vi.mocked(queryCategorySamplesWithAnchor).mockResolvedValueOnce({
      samples: [
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000004",
          startDate: at("2026-11-26T22:00:00Z"),
          endDate: at("2026-11-27T05:00:00Z"),
          value: 4, // asleepDeep
          ...source("Watch"),
        },
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000005",
          startDate: at("2026-11-26T22:00:00Z"),
          endDate: at("2026-11-26T23:00:00Z"),
          value: 99, // A value this catalog doesn't name.
          ...source("Watch"),
        },
      ],
      deletedSamples: [],
      newAnchor: "a3",
    } as never);
    const category = await healthKitSync.changes(SLEEP, undefined, 1000);

    vi.mocked(queryWorkoutSamplesWithAnchor).mockResolvedValueOnce({
      workouts: [
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000006",
          startDate: at("2026-11-27T06:00:00Z"),
          endDate: at("2026-11-27T06:41:00Z"),
          workoutActivityType: 37,
          duration: { quantity: 2460, unit: "s" },
          totalEnergyBurned: { quantity: 402, unit: "kcal" },
          totalDistance: { quantity: 7900, unit: "m" },
          ...source("Watch"),
        },
        {
          uuid: "1F0E2A3B-0000-4000-8000-000000000007",
          startDate: at("2026-11-27T08:00:00Z"),
          endDate: at("2026-11-27T08:30:00Z"),
          workoutActivityType: 9999 as never, // An activity this library version doesn't know.
          duration: { quantity: 1800, unit: "s" },
          ...source("Gym app"),
        },
      ],
      deletedSamples: [],
      newAnchor: "a4",
    } as never);
    const workouts = await healthKitSync.changes(WORKOUT, undefined, 1000);

    const upload: Upload = {
      timeZone: "America/Argentina/Buenos_Aires",
      samples: [...quantity.samples, ...category.samples],
      workouts: workouts.workouts,
      deleted: quantity.deleted,
      characteristics: {
        HKCharacteristicTypeIdentifierDateOfBirth: "1990-04-02",
        HKCharacteristicTypeIdentifierBloodType: "AB−",
        HKCharacteristicTypeIdentifierWheelchairUse: null,
      },
    };
    const parsed = parseChanges(JSON.parse(JSON.stringify(upload)));
    expect(parsed.samples).toHaveLength(4);
    expect(parsed.samples[0]).toMatchObject({ source: "unknown", unit: "count/min" });
    expect(parsed.samples[1]?.source).toHaveLength(200);
    expect(parsed.samples[2]?.value).toBe("asleepDeep");
    expect(parsed.samples[3]?.value).toBe(99);
    expect(parsed.workouts.map((w) => w.activity)).toEqual(["running", "other"]);
  });

  it("accepts every upload the engine makes, daily statistics included", async () => {
    const uploads: Upload[] = [];
    const client: SyncClient = {
      pair: async () => "t",
      upload: async (changes) => {
        uploads.push(changes);
        return "g1";
      },
      reset: async () => "g1",
    };
    const samples = Array.from({ length: 30 }, (_, i) => ({
      id: `1F0E2A3B-0000-4000-8000-${String(i).padStart(12, "0")}`,
      type: STEPS.id,
      start: new Date(Date.UTC(2017, 0, 1 + i * 120)).toISOString(),
      end: new Date(Date.UTC(2017, 0, 1 + i * 120, 1)).toISOString(),
      value: 100,
      unit: "count",
      source: "iPhone",
    }));
    const engine = new SyncEngine(
      {
        types: async () => [STEPS, HEART],
        changes: async (t, anchor) =>
          anchor === undefined && t === STEPS
            ? { samples, workouts: [], deleted: [], anchor: "a" }
            : { samples: [], workouts: [], deleted: [], anchor: "a" },
        dailyStats: async (_t, _s, from, to) => [
          { day: from, value: 1 },
          { day: to, value: 2 },
        ],
        characteristics: async () => ({ HKCharacteristicTypeIdentifierBloodType: "A+" }),
        timeZone: () => "Europe/Berlin",
        dayOf: (d) => d.toISOString().slice(0, 10),
      },
      client,
      {
        load: async () => ({ generation: "g1", anchors: {} }),
        save: async () => undefined,
      },
      () => new Date("2026-11-27T12:00:00Z"),
    );
    await engine.run();
    expect(uploads.some((u) => (u.dailyStats?.length ?? 0) > 0)).toBe(true);
    for (const upload of uploads) {
      const json = JSON.stringify(upload);
      expect(json.length).toBeLessThan(1_000_000);
      expect(() => parseChanges(JSON.parse(json))).not.toThrow();
    }
  });
});
