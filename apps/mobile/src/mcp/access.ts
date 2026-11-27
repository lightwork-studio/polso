import type { Listening } from "./listener";
import { isUsableToken, newToken } from "./token";

/** The port agents connect to: http://<phone>:8765/mcp. */
export const MCP_PORT = 8765;

export type AccessStatus =
  /** Switched off: nothing listens. */
  | { readonly name: "off" }
  /** Switched on, but Polso isn't in front, so nothing listens until it is again. */
  | { readonly name: "paused" }
  | { readonly name: "starting" }
  | { readonly name: "on" }
  /** Couldn't start, or stopped on an error. Access is switched off. */
  | { readonly name: "failed"; readonly message: string };

export interface AccessState {
  readonly enabled: boolean;
  readonly status: AccessStatus;
  /** Loaded once the screen asks for it or access is switched on; never logged. */
  readonly token?: string;
}

/** The parts that need the phone, so the rules below can be tested without one. */
export interface AccessDeps {
  loadToken(): Promise<string | null>;
  saveToken(token: string): Promise<void>;
  deleteToken(): Promise<void>;
  /** A cryptographically secure random source. */
  randomBytes(count: number): Uint8Array;
  /** Starts serving with this token. `onFailure` reports an error after it started. */
  listen(token: string, onFailure: (error: Error) => void): Promise<Listening>;
  keepAwake(on: boolean): void;
}

/**
 * Agent access: off until the person switches it on, and serving only while Polso is in front.
 * While it serves, the screen stays awake so iOS doesn't suspend Polso. The token lives in the
 * Keychain; regenerating it locks out every agent that had the old one.
 */
export class AgentAccess {
  private state: AccessState = { enabled: false, status: { name: "off" } };
  private foreground = true;
  private listening?: Listening;
  /** Set by "New token" until a new one is saved, so the old one is never loaded again. */
  private renewToken = false;
  private readonly listeners = new Set<() => void>();
  private work: Promise<void> = Promise.resolve();

  constructor(private readonly deps: AccessDeps) {}

  getState = (): AccessState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Loads the token, making one on first use. */
  loadToken(): Promise<void> {
    return this.enqueue(async () => {
      await this.token();
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.set({ enabled });
      await this.reconcile();
    });
  }

  setForeground(foreground: boolean): Promise<void> {
    return this.enqueue(async () => {
      this.foreground = foreground;
      await this.reconcile();
    });
  }

  /**
   * Replaces the token. Serving stops and the old token is deleted first, so it stops working even
   * if making or saving the new one fails; then a failure switches access off and says why. Saving
   * overwrites the stored token, so a failed delete matters only if saving fails too, and until a
   * new token is saved, this session never uses the stored one again.
   */
  regenerate(): Promise<void> {
    return this.enqueue(async () => {
      this.stopServing();
      this.set({ token: undefined });
      this.renewToken = true;
      try {
        await this.deps.deleteToken().catch(() => undefined);
        await this.token();
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.fail(new Error(`Couldn't make a new token. ${reason}`));
        return;
      }
      await this.reconcile();
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.work.then(task);
    this.work = run.catch(() => undefined);
    return run;
  }

  private async token(): Promise<string> {
    if (this.state.token) return this.state.token;
    let token = this.renewToken ? null : await this.deps.loadToken();
    if (!isUsableToken(token)) {
      token = newToken(this.deps.randomBytes);
      await this.deps.saveToken(token);
    }
    this.renewToken = false;
    this.set({ token });
    return token;
  }

  private async reconcile(): Promise<void> {
    const serve = this.state.enabled && this.foreground;
    if (!serve) {
      this.stopServing();
      // A failure stays on screen until access is switched on again.
      if (this.state.enabled || this.state.status.name !== "failed") {
        this.set({ status: { name: this.state.enabled ? "paused" : "off" } });
      }
      return;
    }
    if (this.listening) {
      this.set({ status: { name: "on" } });
      return;
    }

    this.set({ status: { name: "starting" } });
    try {
      const token = await this.token();
      const listening = await this.deps.listen(token, (error) => {
        // Checked again when the task runs: a restart queued before it must not be undone.
        void this.enqueue(async () => {
          if (this.listening === listening) this.fail(error);
        });
      });
      this.listening = listening;
      this.deps.keepAwake(true);
      this.set({ status: { name: "on" } });
    } catch (error) {
      this.fail(error);
    }
  }

  private fail(error: unknown): void {
    this.stopServing();
    const message = error instanceof Error ? error.message : String(error);
    this.set({ enabled: false, status: { name: "failed", message } });
  }

  private stopServing(): void {
    if (!this.listening) return;
    this.listening.close();
    this.listening = undefined;
    this.deps.keepAwake(false);
  }

  private set(change: Partial<AccessState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener();
  }
}
