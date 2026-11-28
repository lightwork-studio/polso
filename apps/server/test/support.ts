import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createSyncServer, type ServerOptions } from "../src/server.ts";
import { DATABASE_FILE, Store } from "../src/store.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A fresh data directory, removed after the test. */
export function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "polso-server-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

export function tempStore(): Store {
  const store = Store.open(join(tempDirectory(), DATABASE_FILE));
  cleanups.push(() => store.close());
  return store;
}

/** A running server on a free port, and a fetch bound to it. */
export async function startServer(options: Partial<ServerOptions> = {}) {
  const store = options.store ?? tempStore();
  const server = createSyncServer({ ...options, store });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    call(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { store, server, base, call, post };
}

export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const heartRate = (n: number, value = 60) => ({
  id: UUID(n),
  type: "HKQuantityTypeIdentifierHeartRate",
  start: "2026-11-27T07:00:00.000Z",
  end: "2026-11-27T07:00:00.000Z",
  value,
  unit: "count/min",
  source: "Watch",
});

export const run = (n: number) => ({
  id: UUID(n),
  activity: "running",
  start: "2026-11-27T06:00:00.000Z",
  end: "2026-11-27T06:41:00.000Z",
  durationMinutes: 41,
  energy: { value: 402, unit: "kcal" },
  source: "Watch",
});
