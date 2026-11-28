import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAdmin, UsageError } from "../src/admin.ts";
import { parseChanges } from "../src/changes.ts";
import { ConfigError, readConfig } from "../src/config.ts";
import { LockedError, lockDataDirectory } from "../src/lock.ts";
import { heartRate, startServer, tempDirectory, tempStore } from "./support.ts";

const config = readConfig({ POLSO_PUBLIC_URL: "https://polso.example.com/" });

describe("admin", () => {
  it("makes a pairing link whose code pairs a phone once", async () => {
    const app = await startServer();
    const output = runAdmin(["pair"], app.store, config);
    const link = output.split("\n")[0] as string;
    expect(link).toMatch(/^https:\/\/polso\.example\.com\/pair#[A-Za-z0-9_-]{43}$/);
    const code = link.split("#")[1];
    const pair = () => app.post("/sync/v1/pair", { code, device: "iPhone" });
    expect((await pair()).status).toBe(200);
    expect((await pair()).status).toBe(401);
  });

  it("needs the public address to make a link", () => {
    expect(() => runAdmin(["pair"], tempStore(), readConfig({}))).toThrow("POLSO_PUBLIC_URL");
  });

  it("lists and revokes devices", () => {
    const store = tempStore();
    const now = new Date();
    store.addPairingCode("a", new Date(now.getTime() + 60_000));
    store.pair("a", "iPhone", "t", now);
    expect(runAdmin(["devices", "list"], store, config)).toMatch(/^1\tiPhone\tpaired /);
    expect(() => runAdmin(["devices", "revoke", "7"], store, config)).toThrow("No device 7");
    expect(runAdmin(["devices", "revoke", "1"], store, config)).toBe("Unpaired device 1.");
    expect(runAdmin(["devices", "list"], store, config)).toBe("No paired devices.");
  });

  it("erases only when told --yes", () => {
    const store = tempStore();
    store.apply(parseChanges({ samples: [heartRate(1)] }), new Date());
    expect(() => runAdmin(["erase"], store, config)).toThrow(UsageError);
    expect(store.counts().samples).toBe(1);
    runAdmin(["erase", "--yes"], store, config);
    expect(store.counts().samples).toBe(0);
    expect(runAdmin(["status"], store, config)).toContain("Samples: 0");
  });

  it("shows usage for an unknown command", () => {
    expect(() => runAdmin(["frobnicate"], tempStore(), config)).toThrow(/Usage: polso-server/);
  });
});

describe("config", () => {
  it("defaults to a local listener", () => {
    expect(readConfig({})).toEqual({
      directory: "./data",
      host: "127.0.0.1",
      port: 8788,
      pairing: true,
    });
  });

  it.each([
    [{ POLSO_PUBLIC_URL: "http://polso.example.com" }, "https"],
    [{ POLSO_PUBLIC_URL: "https://polso.example.com/?x=1" }, "query"],
    [{ POLSO_PUBLIC_URL: "not a url" }, "must be a URL"],
    [{ PORT: "http" }, "PORT"],
    [{ POLSO_PAIRING: "maybe" }, "POLSO_PAIRING"],
  ])("rejects %o", (env, message) => {
    expect(() => readConfig(env)).toThrow(ConfigError);
    expect(() => readConfig(env)).toThrow(message);
  });
});

describe("data directory lock", () => {
  it("lets one server at a time use a directory", () => {
    const directory = tempDirectory();
    const release = lockDataDirectory(directory);
    expect(() => lockDataDirectory(directory)).toThrow(LockedError);
    release();
    lockDataDirectory(directory)();
  });
});

describe("command line", () => {
  it("runs from source on Node, without a build step", () => {
    const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
    const output = execFileSync(process.execPath, [main, "admin", "status"], {
      env: { ...process.env, POLSO_DATA: tempDirectory(), NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
    });
    expect(output).toContain("Last upload: never");
  });
});
