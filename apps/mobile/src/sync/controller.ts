import { type SyncClient, SyncError } from "./client";
import { type StateStore, SyncEngine, type SyncSource, type SyncState } from "./engine";
import type { PairingLink } from "./link";

/** What the phone keeps about its server, in the Keychain. */
export interface Pairing {
  readonly server: string;
  readonly token: string;
  /** A random id the sync state carries too, so state from another pairing is never used. */
  readonly id: string;
}

export type SyncStatus =
  | { readonly name: "unpaired" }
  | { readonly name: "idle" }
  | { readonly name: "syncing"; readonly sent: number }
  | { readonly name: "failed"; readonly message: string };

export interface SyncView {
  readonly server?: string;
  readonly status: SyncStatus;
  readonly lastSyncAt?: string;
  /** Types the last run couldn't send, though the others went. */
  readonly skipped?: string;
}

export interface SyncDeps {
  loadPairing(): Promise<Pairing | null>;
  savePairing(pairing: Pairing): Promise<void>;
  deletePairing(): Promise<void>;
  /** The saved sync state of a pairing, or an empty one for any other. */
  loadState(pairingId: string): Promise<SyncState>;
  saveState(pairingId: string, state: SyncState): Promise<void>;
  deleteState(): Promise<void>;
  client(server: string, token: () => string | undefined): SyncClient;
  source: SyncSource;
  /** Whether the person has been asked for Health access; until then there's nothing to send. */
  canRead(): Promise<boolean>;
  randomId(): string;
  /** The name the server lists this phone under. */
  deviceName: string;
}

/** What unpairing did about the server's copy. */
export type Unpaired = "kept" | "erased" | "server-forgot-phone";

export const UNPAIRED =
  "The server no longer knows this phone: it was unpaired there. Pair again with a new link.";
export const NO_HEALTH_ACCESS =
  "Allow Health access on Polso's first screen; then Polso can send your data.";

/**
 * Sync with the person's own server: pairing, runs one at a time, and what the screen shows.
 * Runs come from the app opening or coming to the front and the Sync button; a run asked for
 * while one waits joins it. Unpairing or pairing elsewhere stops a run at once.
 */
export class SyncController {
  private view: SyncView = { status: { name: "unpaired" } };
  private pairing?: Pairing;
  private readonly listeners = new Set<() => void>();
  private work: Promise<void> = Promise.resolve();
  private loading?: Promise<void>;
  private running?: AbortController;
  private queuedSync?: Promise<void>;

  constructor(private readonly deps: SyncDeps) {}

  getView = (): SyncView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reads the pairing from the Keychain, once; never waits behind a run. */
  load(): Promise<void> {
    this.loading ??= (async () => {
      const pairing = await this.deps.loadPairing();
      if (!pairing) return;
      this.pairing = pairing;
      const state = await this.deps.loadState(pairing.id);
      this.set({
        server: pairing.server,
        status: { name: "idle" },
        ...(state.lastSyncAt !== undefined && { lastSyncAt: state.lastSyncAt }),
      });
    })().catch((error: unknown) => {
      // A failed read (the Keychain before first unlock, say) is tried again next time.
      this.loading = undefined;
      throw error;
    });
    return this.loading;
  }

  /**
   * Pairs with the link's server, replacing any earlier pairing; resolves once the pairing is
   * saved. The first sync starts after that, on its own.
   */
  async pair(link: PairingLink): Promise<void> {
    // A known pairing is set aside before anything waits, so no further batch goes out.
    if (!this.pairing) await this.load().catch(() => undefined);
    // The earlier server gets nothing more: the run going now stops, and queued runs find no
    // pairing. It comes back if this pairing fails.
    const earlier = this.pairing;
    this.pairing = undefined;
    this.running?.abort();
    await this.enqueue(async () => {
      let pairing: Pairing;
      try {
        const client = this.deps.client(link.server, () => undefined);
        const token = await client.pair(link.code, this.deps.deviceName);
        pairing = { server: link.server, token, id: this.deps.randomId() };
        await this.deps.savePairing(pairing);
      } catch (error) {
        this.pairing = earlier;
        throw error;
      }
      // The earlier pairing's progress means nothing for this server.
      await this.deps.deleteState().catch(() => undefined);
      this.pairing = pairing;
      this.view = { server: link.server, status: { name: "idle" } };
      this.notify();
    });
    void this.sync();
  }

  /** Syncs after any run going now. Errors show on screen rather than throw. */
  sync(): Promise<void> {
    this.queuedSync ??= this.enqueue(async () => {
      this.queuedSync = undefined;
      try {
        await this.load();
      } catch {
        return; // The Keychain isn't readable yet; the next run tries again.
      }
      await this.runSync();
    });
    return this.queuedSync;
  }

  /** Erases the server's copy and sends the whole history again. */
  resendEverything(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.pairing) return;
      // Without a generation the next run erases the server's copy first (see SyncEngine).
      await this.deps.saveState(this.pairing.id, { anchors: {} });
      await this.runSync();
    });
  }

  /**
   * Forgets the server, stopping any run at once. With `erase`, the server's copy goes first;
   * if that fails for a reason other than the server having forgotten the phone, nothing is
   * forgotten, so the person can try again.
   */
  async unpair(erase: boolean): Promise<Unpaired> {
    // A known pairing is set aside before anything waits, so no further batch goes out.
    if (!this.pairing) await this.load().catch(() => undefined);
    const pairing = this.pairing;
    if (!pairing) return "kept";
    // Stops the run going now, and keeps queued runs from starting.
    this.pairing = undefined;
    this.running?.abort();
    let result: Unpaired = "kept";
    await this.enqueue(async () => {
      if (erase) {
        try {
          await this.deps.client(pairing.server, () => pairing.token).reset();
          result = "erased";
        } catch (error) {
          if (!(error instanceof SyncError && error.kind === "unpaired")) {
            this.pairing = pairing;
            throw error;
          }
          result = "server-forgot-phone";
        }
      }
      await this.deps.deletePairing();
      await this.deps.deleteState();
      this.view = { status: { name: "unpaired" } };
      this.notify();
    });
    return result;
  }

  private async runSync(): Promise<void> {
    const pairing = this.pairing;
    if (!pairing) return;
    if (!(await this.deps.canRead())) {
      this.set({ status: { name: "failed", message: NO_HEALTH_ACCESS } });
      return;
    }
    const store: StateStore = {
      load: () => this.deps.loadState(pairing.id),
      save: (state) => this.deps.saveState(pairing.id, state),
    };
    const engine = new SyncEngine(
      this.deps.source,
      this.deps.client(pairing.server, () => pairing.token),
      store,
    );
    const running = new AbortController();
    this.running = running;
    this.set({ status: { name: "syncing", sent: 0 } });
    try {
      const { failed } = await engine.run({
        signal: running.signal,
        onProgress: ({ sent }) => this.set({ status: { name: "syncing", sent } }),
      });
      const state = await store.load();
      this.view = {
        server: pairing.server,
        status: { name: "idle" },
        ...(state.lastSyncAt !== undefined && { lastSyncAt: state.lastSyncAt }),
        ...(failed.length > 0 && {
          skipped: `${failed.map((f) => f.label).join(", ")}: ${failed[0]?.message}`,
        }),
      };
      this.notify();
    } catch (error) {
      if (error instanceof SyncError && error.kind === "stopped") return;
      const message =
        error instanceof SyncError
          ? error.kind === "unpaired"
            ? UNPAIRED
            : error.message
          : "Couldn't read Health data or save progress on this phone.";
      this.set({ status: { name: "failed", message } });
    } finally {
      if (this.running === running) this.running = undefined;
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.work.then(task);
    this.work = run.catch(() => undefined);
    return run;
  }

  private set(change: Partial<SyncView>): void {
    this.view = { ...this.view, ...change };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
