import type { HealthType } from "./catalog";

/** What Polso shows for one type after reading it. */
export type Preview =
  /** The most recent record, formatted for display. */
  | { readonly status: "value"; readonly text: string; readonly date?: Date }
  /**
   * Nothing readable. HealthKit doesn't tell apps whether read access was declined, so this
   * covers both "nothing recorded" and "access not granted".
   */
  | { readonly status: "empty" }
  /** Access is requested, but Polso doesn't preview this kind of data yet. */
  | { readonly status: "notPreviewed" }
  /** The type doesn't exist on this iOS version, so Polso doesn't ask for it. */
  | { readonly status: "unavailable" }
  | { readonly status: "error"; readonly message: string };

/** The parts of HealthKit Polso uses, so the reading logic can be tested without a device. */
export interface HealthSource {
  isHealthDataAvailable(): boolean;
  /** Which of the identifiers exist on this device's iOS version. */
  availability(ids: readonly string[]): Record<string, boolean>;
  /** Whether asking for these types would show the permission sheet. */
  needsRequest(ids: readonly string[]): Promise<boolean>;
  /** Asks for read access only. Polso never asks to write Health data. */
  requestRead(ids: readonly string[]): Promise<void>;
  latest(type: HealthType): Promise<Preview>;
}

export function availableTypes(
  source: HealthSource,
  types: readonly HealthType[],
): readonly HealthType[] {
  const available = source.availability(types.map((t) => t.id));
  return types.filter((t) => available[t.id] === true);
}

/**
 * Shows the permission sheet for every type this iOS version has. Types the system doesn't know
 * are left out, so the request only names types the person can actually grant.
 */
export async function requestReadAccess(
  source: HealthSource,
  types: readonly HealthType[],
): Promise<void> {
  const ids = availableTypes(source, types).map((t) => t.id);
  if (ids.length > 0) await source.requestRead(ids);
}

export interface ReadOptions {
  /** How many HealthKit queries run at once. */
  readonly concurrency?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Reads the most recent record of each type. One failing query marks only its own type as an
 * error; the others are still read.
 */
export async function readPreviews(
  source: HealthSource,
  types: readonly HealthType[],
  { concurrency = 6, onProgress }: ReadOptions = {},
): Promise<Map<string, Preview>> {
  const previews = new Map<string, Preview>();
  const available = new Set(availableTypes(source, types).map((t) => t.id));
  const queue: HealthType[] = [];
  for (const type of types) {
    if (available.has(type.id)) queue.push(type);
    else previews.set(type.id, { status: "unavailable" });
  }

  const total = queue.length;
  let done = 0;
  let next = 0;
  const worker = async () => {
    while (next < queue.length) {
      const type = queue[next++] as HealthType;
      let preview: Preview;
      try {
        preview = await source.latest(type);
      } catch (error) {
        preview = {
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      previews.set(type.id, preview);
      onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, worker));
  return previews;
}
