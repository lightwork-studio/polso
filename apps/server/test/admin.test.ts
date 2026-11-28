import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAdmin, UsageError } from "../src/admin.ts";
import { parseChanges } from "../src/changes.ts";
import { ConfigError, readConfig } from "../src/config.ts";
import { LockedError, lockDataDirectory } from "../src/lock.ts";
import { DATABASE_FILE, Store } from "../src/store.ts";
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

  it("needs the public address to make a link, or takes the one the server recorded", () => {
    const store = tempStore();
    expect(() => runAdmin(["pair"], store, readConfig({}))).toThrow("POLSO_PUBLIC_URL");
    store.saveSetting("publicUrl", "https://recorded.example.com");
    store.saveSetting("pairing", "off");
    const output = runAdmin(["pair"], store, readConfig({}));
    expect(output).toMatch(/^https:\/\/recorded\.example\.com\/pair#/);
    expect(output).toContain("POLSO_PAIRING=off");
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
    expect(runAdmin(["erase", "--yes"], store, config)).toMatch(/^Erased 1 samples, 0 workouts/);
    expect(store.counts().samples).toBe(0);
    expect(runAdmin(["status"], store, config)).toContain("Samples: 0");
  });

  it("shows usage for an unknown command", () => {
    expect(() => runAdmin(["frobnicate"], tempStore(), config)).toThrow(/Usage: polso-server/);
  });
});

describe("config", () => {
  it("ignores the generic HOST and PORT that shells and platforms set", () => {
    expect(readConfig({ HOST: "0.0.0.0", PORT: "80" })).toMatchObject({
      host: "127.0.0.1",
      port: 8788,
    });
    expect(readConfig({ POLSO_HOST: "::1", POLSO_PORT: "9000" })).toMatchObject({
      host: "::1",
      port: 9000,
    });
  });

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
    [{ POLSO_PUBLIC_URL: "https://example.com/polso" }, "without a path"],
    [{ POLSO_PORT: "http" }, "POLSO_PORT"],
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
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const cli = (directory: string, ...args: string[]) =>
    spawnSync(process.execPath, [main, ...args], {
      env: { ...process.env, POLSO_DATA: directory, NODE_NO_WARNINGS: "1" },
      encoding: "utf8",
    });

  it("runs from source on Node, without a build step", () => {
    const directory = tempDirectory();
    Store.open(join(directory, DATABASE_FILE)).close();
    const result = cli(directory, "admin", "status");
    expect(result.stdout).toContain("Last upload: never");
    expect(result.status).toBe(0);
  });

  it("won't act on a data directory without a database", () => {
    const directory = join(tempDirectory(), "typo");
    for (const args of [
      ["erase", "--yes"],
      ["devices", "revoke", "--all"],
    ]) {
      const result = cli(directory, "admin", ...args);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("No Polso database");
    }
    expect(existsSync(directory)).toBe(false);
  });
});
