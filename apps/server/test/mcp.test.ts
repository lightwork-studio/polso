import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runAdmin } from "../src/admin.ts";
import { parseChanges } from "../src/changes.ts";
import { readConfig } from "../src/config.ts";
import { adoptTimeZone } from "../src/queries.ts";
import { MAX_MCP_BYTES } from "../src/server.ts";
import { hashSecret, newSecret } from "../src/tokens.ts";
import { heartRate, run, startServer, UUID } from "./support.ts";

const config = readConfig({ POLSO_PUBLIC_URL: "https://polso.example.com" });

let savedZone: string | undefined;
beforeEach(() => {
  savedZone = process.env.TZ;
});
afterEach(() => {
  if (savedZone === undefined) delete process.env.TZ;
  else process.env.TZ = savedZone;
});

/** A server holding some data, and an agent token for it. */
async function serverWithData() {
  const app = await startServer();
  app.store.apply(
    parseChanges({
      timeZone: "Pacific/Auckland",
      samples: [
        { ...heartRate(1, 58), start: "2026-11-25T06:00:00.000Z", end: "2026-11-25T06:00:00.000Z" },
        { ...heartRate(2, 64), start: "2026-11-26T06:00:00.000Z", end: "2026-11-26T06:00:00.000Z" },
        {
          id: UUID(3),
          type: "HKCategoryTypeIdentifierSleepAnalysis",
          start: "2026-11-25T10:00:00.000Z",
          end: "2026-11-25T17:00:00.000Z",
          value: "asleepCore",
          source: "Watch",
        },
      ],
      workouts: [run(4)],
      dailyStats: [
        {
          type: "HKQuantityTypeIdentifierStepCount",
          statistic: "sum",
          unit: "count",
          from: "2026-11-24",
          to: "2026-11-26",
          values: [
            { day: "2026-11-24", value: 4000 },
            { day: "2026-11-26", value: 9000 },
          ],
        },
      ],
      characteristics: { HKCharacteristicTypeIdentifierBloodType: "A+" },
    }),
    new Date("2026-11-27T00:00:00.000Z"),
  );
  const output = runAdmin(["agents", "add", "Claude"], app.store, config);
  const token = output.split("\n")[2] as string;
  let id = 0;
  const call = (method: string, params: unknown = {}, headers: Record<string, string> = {}) =>
    app.post(
      "/mcp",
      { jsonrpc: "2.0", id: ++id, method, params },
      {
        Authorization: `Bearer ${token}`,
        Accept: "application/json, text/event-stream",
        ...headers,
      },
    );
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await call("tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      result: { structuredContent?: unknown; isError?: boolean; content: { text: string }[] };
    };
    if (body.result.isError) throw new Error(body.result.content[0]?.text);
    return body.result.structuredContent as Record<string, unknown>;
  };
  return { ...app, token, call, tool, output };
}

describe("MCP endpoint", () => {
  it("prints a token once, with setup for Claude Code and other clients", async () => {
    const { output, token } = await serverWithData();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(output).toContain(
      `claude mcp add --transport http polso https://polso.example.com/mcp --header "Authorization: Bearer ${token}"`,
    );
    expect(output).toContain('"url": "https://polso.example.com/mcp"');
  });

  it("answers an agent with its token", async () => {
    const { call } = await serverWithData();
    const response = await call("tools/list");
    expect(response.status).toBe(200);
    const { result } = (await response.json()) as { result: { tools: { name: string }[] } };
    expect(result.tools.map((t) => t.name)).toEqual([
      "list_health_types",
      "get_latest",
      "get_samples",
      "get_daily_stats",
      "get_workouts",
      "get_sleep",
    ]);
  });

  it.each([
    ["no token", {}],
    ["an unknown token", { Authorization: `Bearer ${newSecret()}` }],
    ["a malformed token", { Authorization: "Bearer nope" }],
  ])("refuses a request with %s", async (_, headers) => {
    const app = await serverWithData();
    const response = await app.post(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { Authorization: "", ...headers },
    );
    expect(response.status).toBe(401);
  });

  it("doesn't take a phone's device token as an agent's", async () => {
    const app = await serverWithData();
    const code = newSecret();
    app.store.addPairingCode(hashSecret(code), new Date(Date.now() + 60_000));
    const paired = await app.post("/sync/v1/pair", { code, device: "iPhone" });
    const { token } = (await paired.json()) as { token: string };
    const response = await app.call("tools/list", {}, { Authorization: `Bearer ${token}` });
    expect(response.status).toBe(401);
  });

  it("locks a revoked agent out at once", async () => {
    const app = await serverWithData();
    expect((await app.call("tools/list")).status).toBe(200);
    runAdmin(["agents", "revoke", "--all"], app.store, config);
    expect((await app.call("tools/list")).status).toBe(401);
  });

  it("refuses web pages, even with a valid token", async () => {
    const app = await serverWithData();
    const response = await app.call("tools/list", {}, { Origin: "https://evil.example" });
    expect(response.status).toBe(403);
  });

  it("refuses an oversized message", async () => {
    const app = await serverWithData();
    const response = await app.call("tools/list", { padding: "x".repeat(MAX_MCP_BYTES) });
    expect(response.status).toBe(413);
  });

  it("lists only the types it holds data for, in the phone's time zone", async () => {
    const { tool } = await serverWithData();
    const result = await tool("list_health_types");
    expect(result.timeZone).toBe("Pacific/Auckland");
    const types = (result.types as { type: string }[]).map((t) => t.type).sort();
    expect(types).toEqual(["BloodType", "HeartRate", "SleepAnalysis", "StepCount", "Workout"]);
  });

  it("reads records newest first, and the latest one", async () => {
    const { tool } = await serverWithData();
    const samples = await tool("get_samples", {
      type: "HeartRate",
      start: "2026-11-01",
      end: "2026-11-30",
    });
    expect((samples.records as { value: number }[]).map((r) => r.value)).toEqual([64, 58]);
    const latest = await tool("get_latest", { type: "HeartRate" });
    expect(latest.latest).toMatchObject({ value: 64, unit: "count/min", source: "Watch" });
    const blood = await tool("get_latest", { type: "BloodType" });
    expect(blood.value).toBe("A+");
  });

  it("returns HealthKit's daily statistics by the phone's days", async () => {
    const { tool } = await serverWithData();
    const stats = await tool("get_daily_stats", {
      type: "StepCount",
      start: "2026-11-24",
      end: "2026-11-26",
    });
    expect(JSON.stringify(stats)).toContain("9000");
    expect(JSON.stringify(stats)).toContain("4000");
    expect(JSON.stringify(stats)).toContain("2026-11-26");
  });

  it("summarizes sleep and lists workouts", async () => {
    const { tool } = await serverWithData();
    const sleep = await tool("get_sleep", { start: "2026-11-25", end: "2026-11-25" });
    expect(JSON.stringify(sleep)).toContain("asleepCore");
    const workouts = await tool("get_workouts", { start: "2026-11-01", end: "2026-11-30" });
    expect(workouts.workouts).toEqual([
      expect.objectContaining({ activity: "running", durationMinutes: 41 }),
    ]);
  });
});

describe("time zone", () => {
  it("adopts a known zone and ignores an unknown one", () => {
    adoptTimeZone("Pacific/Auckland");
    expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe("Pacific/Auckland");
    adoptTimeZone("America/New_Town");
    expect(process.env.TZ).toBe("Pacific/Auckland");
  });
});

describe("agent admin", () => {
  it("lists and revokes agents", async () => {
    const { store } = await serverWithData();
    expect(runAdmin(["agents", "list"], store, config)).toMatch(
      /^1\tClaude\tadded .*last read never$/,
    );
    expect(() => runAdmin(["agents", "add"], store, config)).toThrow("Name the agent");
    expect(() => runAdmin(["agents", "revoke", "9"], store, config)).toThrow("No agent 9");
    expect(runAdmin(["agents", "revoke", "1"], store, config)).toBe("Revoked agent 1.");
    expect(runAdmin(["agents", "list"], store, config)).toBe("No agents.");
  });
});
