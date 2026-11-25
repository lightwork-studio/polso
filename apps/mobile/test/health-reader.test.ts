import { describe, expect, it } from "vitest";
import type { HealthType } from "../src/health/catalog";
import {
  type HealthSource,
  type Preview,
  readPreviews,
  requestReadAccess,
} from "../src/health/reader";
import { previewLabel, summarize } from "../src/health/summary";

const type = (id: string): HealthType => ({ id, kind: "quantity", label: id });
const steps = type("HKQuantityTypeIdentifierStepCount");
const heartRate = type("HKQuantityTypeIdentifierHeartRate");
const newType = type("HKQuantityTypeIdentifierFromAFutureIOS");

function fakeSource(options: {
  missing?: string[];
  latest?: (t: HealthType) => Promise<Preview>;
}): HealthSource & { requested: string[][] } {
  const requested: string[][] = [];
  return {
    requested,
    isHealthDataAvailable: () => true,
    availability: (ids) =>
      Object.fromEntries(ids.map((id) => [id, !options.missing?.includes(id)])),
    needsRequest: async () => true,
    requestRead: async (ids) => {
      requested.push([...ids]);
    },
    latest: options.latest ?? (async () => ({ status: "empty" })),
  };
}

describe("asking for access", () => {
  it("asks only for types this iOS version has", async () => {
    const source = fakeSource({ missing: [newType.id] });
    await requestReadAccess(source, [steps, newType, heartRate]);
    expect(source.requested).toEqual([[steps.id, heartRate.id]]);
  });

  it("doesn't show an empty permission sheet", async () => {
    const source = fakeSource({ missing: [newType.id] });
    await requestReadAccess(source, [newType]);
    expect(source.requested).toEqual([]);
  });
});

describe("reading", () => {
  it("reads each available type and marks the rest unavailable without querying them", async () => {
    const queried: string[] = [];
    const source = fakeSource({
      missing: [newType.id],
      latest: async (t) => {
        queried.push(t.id);
        return t === steps ? { status: "value", text: "8,214" } : { status: "empty" };
      },
    });
    const previews = await readPreviews(source, [steps, heartRate, newType]);
    expect(queried.sort()).toEqual([heartRate.id, steps.id].sort());
    expect(previews.get(steps.id)).toEqual({ status: "value", text: "8,214" });
    expect(previews.get(heartRate.id)).toEqual({ status: "empty" });
    expect(previews.get(newType.id)).toEqual({ status: "unavailable" });
  });

  it("keeps reading other types when one query fails", async () => {
    const source = fakeSource({
      latest: async (t) => {
        if (t === heartRate) throw new Error("Protected data is unavailable");
        return { status: "value", text: "8,214" };
      },
    });
    const previews = await readPreviews(source, [heartRate, steps]);
    expect(previews.get(heartRate.id)).toEqual({
      status: "error",
      message: "Protected data is unavailable",
    });
    expect(previews.get(steps.id)).toEqual({ status: "value", text: "8,214" });
  });

  it("runs a limited number of queries at once and reports progress to the end", async () => {
    const types = Array.from({ length: 20 }, (_, i) => type(`T${i}`));
    let inFlight = 0;
    let peak = 0;
    const source = fakeSource({
      latest: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return { status: "empty" };
      },
    });
    const progress: number[] = [];
    const previews = await readPreviews(source, types, {
      concurrency: 3,
      onProgress: (done, total) => {
        expect(total).toBe(20);
        progress.push(done);
      },
    });
    expect(peak).toBe(3);
    expect(progress).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(previews.size).toBe(20);
  });
});

describe("summary", () => {
  it("counts requested types with data, leaving out ones this iOS doesn't have", () => {
    const previews = new Map<string, Preview>([
      ["a", { status: "value", text: "1" }],
      ["b", { status: "empty" }],
      ["c", { status: "unavailable" }],
      ["d", { status: "error", message: "x" }],
      ["e", { status: "notPreviewed" }],
    ]);
    expect(summarize(previews)).toEqual({ requested: 4, withData: 1 });
  });

  it("labels each status", () => {
    expect(previewLabel({ status: "empty" })).toBe("No data");
    expect(previewLabel({ status: "notPreviewed" })).toBe("Access requested");
    expect(previewLabel({ status: "unavailable" })).toBe("Needs a newer iOS");
    expect(previewLabel({ status: "error", message: "x" })).toBe("Couldn't read");
  });
});
