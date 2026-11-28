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
  randomId(): string;
  /** The name the server lists this phone under. */
  deviceName: string;
}

/**
 * Sync with the person's own server: pairing, runs one at a time, and what the screen shows.
 * Runs come from the app opening or coming to the front, the Sync button, and (later) HealthKit
 * waking Polso; one asked for during a run waits for it rather than running alongside.
 */
export class SyncController {
  private view: SyncView = { status: { name: "unpaired" } };
  private pairing?: Pairing;
  private readonly listeners = new Set<() => void>();
  private work: Promise<void> = Promise.resolve();
  private loaded = false;

  constructor(private readonly deps: SyncDeps) {}

  getView = (): SyncView => this.view;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Reads the pairing from the Keychain once. */
  load(): Promise<void> {
    return this.enqueue(async () => {
      if (this.loaded) return;
      const pairing = await this.deps.loadPairing();
      this.loaded = true;
      if (!pairing) return;
      this.pairing = pairing;
      const state = await this.deps.loadState(pairing.id);
      this.set({
        server: pairing.server,
        status: { name: "idle" },
        ...(state.lastSyncAt !== undefined && { lastSyncAt: state.lastSyncAt }),
      });
    });
  }

  /** Pairs with the link's server, replacing any earlier pairing, then syncs. */
  pair(link: PairingLink): Promise<void> {
    return this.enqueue(async () => {
      const client = this.deps.client(link.server, () => undefined);
      const token = await client.pair(link.code, this.deps.deviceName);
      const pairing = { server: link.server, token, id: this.deps.randomId() };
      await this.deps.savePairing(pairing);
      await this.deps.deleteState();
      this.pairing = pairing;
      this.loaded = true;
      this.view = { server: link.server, status: { name: "idle" } };
      this.notify();
      await this.runSync();
    });
  }

  /** Syncs now, after any run already going. Errors show on screen rather than throw. */
  sync(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.loaded) {
        this.loaded = true;
        const pairing = await this.deps.loadPairing();
        if (pairing) this.pairing = pairing;
      }
      if (this.pairing) await this.runSync();
    });
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
   * Forgets the server. With `erase`, the server's copy goes first; if that fails, nothing is
   * forgotten, so the person can try again.
   */
  unpair(erase: boolean): Promise<void> {
    return this.enqueue(async () => {
      const pairing = this.pairing;
      if (!pairing) return;
      if (erase) await this.deps.client(pairing.server, () => pairing.token).reset();
      await this.deps.deletePairing();
      await this.deps.deleteState();
      this.pairing = undefined;
      this.view = { status: { name: "unpaired" } };
      this.notify();
    });
  }

  private async runSync(): Promise<void> {
    const pairing = this.pairing;
    if (!pairing) return;
    const store: StateStore = {
      load: () => this.deps.loadState(pairing.id),
      save: (state) => this.deps.saveState(pairing.id, state),
    };
    const engine = new SyncEngine(
      this.deps.source,
      this.deps.client(pairing.server, () => pairing.token),
      store,
    );
    this.set({ status: { name: "syncing", sent: 0 } });
    try {
      await engine.run(({ sent }) => this.set({ status: { name: "syncing", sent } }));
      const state = await store.load();
      this.set({
        status: { name: "idle" },
        ...(state.lastSyncAt !== undefined && { lastSyncAt: state.lastSyncAt }),
      });
    } catch (error) {
      if (error instanceof SyncError && error.kind === "unpaired") {
        this.set({ status: { name: "failed", message: UNPAIRED } });
        return;
      }
      const message =
        error instanceof SyncError ? error.message : "Couldn't read Health data to send.";
      this.set({ status: { name: "failed", message } });
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

export const UNPAIRED =
  "The server no longer knows this phone: it was unpaired there. Pair again with a new link.";
