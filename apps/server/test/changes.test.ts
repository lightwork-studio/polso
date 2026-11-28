import { describe, expect, it } from "vitest";
import { ChangesError, LIMITS, parseChanges } from "../src/changes.ts";
import { heartRate, run, UUID } from "./support.ts";

const sleep = {
  id: UUID(9),
  type: "HKCategoryTypeIdentifierSleepAnalysis",
  start: "2026-11-26T22:40:00.000Z",
  end: "2026-11-27T00:10:00.000Z",
  value: "asleepCore",
  source: "Watch",
};
const steps = {
  type: "HKQuantityTypeIdentifierStepCount",
  statistic: "sum",
  from: "2026-11-20",
  to: "2026-11-27",
  values: [{ day: "2026-11-27", value: 8412 }],
};

const rejects = (body: unknown, message: string | RegExp) =>
  expect(() => parseChanges(body)).toThrow(message);

describe("parseChanges", () => {
  it("reads a full upload", () => {
    const changes = parseChanges({
      timeZone: "Europe/Berlin",
      samples: [heartRate(1), sleep],
      workouts: [run(2)],
      deleted: [UUID(3)],
      dailyStats: [steps],
      characteristics: {
        HKCharacteristicTypeIdentifierBloodType: "A+",
        HKCharacteristicTypeIdentifierWheelchairUse: null,
      },
    });
    expect(changes.timeZone).toBe("Europe/Berlin");
    expect(changes.samples[0]).toMatchObject({ value: 60, unit: "count/min" });
    expect(changes.samples[0]?.start).toEqual(new Date("2026-11-27T07:00:00.000Z"));
    expect(changes.samples[1]).toMatchObject({ value: "asleepCore" });
    expect(changes.samples[1]).not.toHaveProperty("unit");
    expect(changes.workouts[0]).toMatchObject({ durationMinutes: 41, energy: { value: 402 } });
    expect(changes.deleted).toEqual([UUID(3)]);
    expect(changes.dailyStats[0]?.values).toEqual([{ day: "2026-11-27", value: 8412 }]);
    expect(changes.characteristics).toEqual([
      ["HKCharacteristicTypeIdentifierBloodType", "A+"],
      ["HKCharacteristicTypeIdentifierWheelchairUse", null],
    ]);
  });

  it("accepts an empty upload", () => {
    expect(parseChanges({})).toMatchObject({ samples: [], deleted: [], dailyStats: [] });
  });

  it("accepts a zone this server's time zone data doesn't know yet", () => {
    expect(parseChanges({ timeZone: "America/New_Town" }).timeZone).toBe("America/New_Town");
  });

  it("keeps the unit of daily statistics", () => {
    const changes = parseChanges({ dailyStats: [{ ...steps, unit: "count" }] });
    expect(changes.dailyStats[0]?.unit).toBe("count");
  });

  it("accepts a type this server doesn't list yet", () => {
    const newer = { ...heartRate(1), type: "HKQuantityTypeIdentifierSomethingNew2030" };
    expect(parseChanges({ samples: [newer] }).samples[0]?.type).toBe(newer.type);
  });

  it.each([
    ["not an object", [], "body: expected an object"],
    ["a bad type", { samples: [{ ...heartRate(1), type: "steps" }] }, "samples[0].type"],
    ["a bad id", { samples: [{ ...heartRate(1), id: "x'; DROP" }] }, "samples[0].id"],
    ["a local time", { samples: [{ ...heartRate(1), start: "2026-11-27T07:00:00" }] }, "start"],
    ["an impossible time", { samples: [{ ...heartRate(1), end: "2026-13-40T99:00:00Z" }] }, "end"],
    [
      "an end before the start",
      { samples: [{ ...heartRate(1), end: "2026-11-27T06:00:00.000Z" }] },
      "ends before it starts",
    ],
    [
      "an infinite value",
      { samples: [{ ...heartRate(1), value: Number.POSITIVE_INFINITY }] },
      "samples[0].value",
    ],
    ["a missing source", { samples: [{ ...heartRate(1), source: "" }] }, "samples[0].source"],
    [
      "an overlong source",
      { samples: [{ ...heartRate(1), source: "x".repeat(LIMITS.text + 1) }] },
      "longer than",
    ],
    ["a negative duration", { workouts: [{ ...run(1), durationMinutes: -1 }] }, "is negative"],
    ["a bad deletion", { deleted: [42] }, "deleted[0]"],
    ["an unknown statistic", { dailyStats: [{ ...steps, statistic: "median" }] }, "statistic"],
    [
      "a day that doesn't exist",
      { dailyStats: [{ ...steps, to: "2026-02-30" }] },
      "not a real day",
    ],
    [
      "a value outside its range",
      { dailyStats: [{ ...steps, values: [{ day: "2026-12-01", value: 1 }] }] },
      "outside from and to",
    ],
    [
      "a day twice",
      {
        dailyStats: [
          {
            ...steps,
            values: [
              { day: "2026-11-27", value: 1 },
              { day: "2026-11-27", value: 2 },
            ],
          },
        ],
      },
      "a day appears twice",
    ],
    ["a malformed time zone", { timeZone: "../../etc/passwd" }, "timeZone"],
    ["a bad characteristic", { characteristics: { bloodType: "A+" } }, "characteristics"],
  ])("rejects %s", (_, body, message) => {
    rejects(body, message);
  });

  it("rejects an upload over the record limit", () => {
    const samples = Array.from({ length: LIMITS.records }, (_, i) => heartRate(i));
    expect(() => parseChanges({ samples })).not.toThrow();
    rejects({ samples, workouts: [run(LIMITS.records + 1)] }, "split the upload");
  });

  it("throws ChangesError, so the server can answer 400", () => {
    expect(() => parseChanges(null)).toThrow(ChangesError);
  });
});
