/*
 * The phone's side of the sync protocol (docs/sync-protocol.md): pairing, uploads and resets,
 * over https to the person's own server.
 */

export interface SampleUpload {
  readonly id: string;
  readonly type: string;
  readonly start: string;
  readonly end: string;
  readonly value: number | string;
  readonly unit?: string;
  readonly source: string;
}

export interface WorkoutUpload {
  readonly id: string;
  readonly activity: string;
  readonly start: string;
  readonly end: string;
  readonly durationMinutes: number;
  readonly energy?: { readonly value: number; readonly unit: string };
  readonly distance?: { readonly value: number; readonly unit: string };
  readonly source: string;
}

export interface DailyStatsUpload {
  readonly type: string;
  readonly statistic: "sum" | "average" | "min" | "max";
  readonly unit?: string;
  readonly from: string;
  readonly to: string;
  readonly values: readonly { readonly day: string; readonly value: number }[];
}

export interface Upload {
  readonly timeZone?: string;
  readonly samples?: readonly SampleUpload[];
  readonly workouts?: readonly WorkoutUpload[];
  readonly deleted?: readonly string[];
  readonly dailyStats?: readonly DailyStatsUpload[];
  readonly characteristics?: Readonly<Record<string, string | null>>;
}

export type SyncErrorKind =
  /** The server doesn't know this phone (any more): pair again. */
  | "unpaired"
  /** Try again later: the server is busy, unreachable, or the request timed out. */
  | "unavailable"
  /** The server refused the request as it was; trying again won't help. */
  | "refused";

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  constructor(kind: SyncErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface SyncClient {
  /** Trades a pairing code for a device token. */
  pair(code: string, device: string): Promise<string>;
  /** Sends changes; returns the server's data generation. */
  upload(changes: Upload): Promise<string>;
  /** Erases the server's copy; returns the new generation. */
  reset(): Promise<string>;
}

/** How long one request may take, an upload of about a megabyte included. */
export const REQUEST_TIMEOUT_MS = 60_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

async function errorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // Not the server's JSON: a proxy's page, say.
  }
  return `The server answered ${response.status}.`;
}

export function httpClient(
  server: string,
  token: () => string | undefined,
  fetchFn: Fetch = fetch,
): SyncClient {
  async function post(path: string, body: unknown, authorized: boolean): Promise<unknown> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authorized) {
      const value = token();
      if (!value) throw new SyncError("unpaired", "This phone isn't paired with a server.");
      headers.Authorization = `Bearer ${value}`;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchFn(`${server}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch {
      throw new SyncError("unavailable", "Couldn't reach the server.");
    } finally {
      clearTimeout(timer);
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new SyncError("unavailable", "The server's answer was cut off.");
      }
    }
    const message = await errorText(response);
    if (response.status === 401) throw new SyncError("unpaired", message);
    if (response.status === 503 || response.status === 502 || response.status === 504) {
      throw new SyncError("unavailable", message);
    }
    throw new SyncError("refused", message);
  }

  const generationOf = (body: unknown): string => {
    const generation = (body as { generation?: unknown } | null)?.generation;
    if (typeof generation !== "string" || generation === "") {
      throw new SyncError("refused", "The server didn't name its data generation.");
    }
    return generation;
  };

  return {
    async pair(code, device) {
      const body = (await post("/sync/v1/pair", { code, device }, false)) as { token?: unknown };
      if (typeof body?.token !== "string") {
        throw new SyncError("refused", "The server didn't hand out a token.");
      }
      return body.token;
    },
    upload: async (changes) => generationOf(await post("/sync/v1/changes", changes, true)),
    reset: async () => generationOf(await post("/sync/v1/reset", {}, true)),
  };
}
