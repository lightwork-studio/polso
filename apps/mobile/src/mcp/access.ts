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

  /** Replaces the token. If access is serving, it restarts so only the new token works. */
  regenerate(): Promise<void> {
    return this.enqueue(async () => {
      const token = newToken(this.deps.randomBytes);
      await this.deps.saveToken(token);
      this.set({ token });
      this.stopServing();
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
    let token = await this.deps.loadToken();
    if (!isUsableToken(token)) {
      token = newToken(this.deps.randomBytes);
      await this.deps.saveToken(token);
    }
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
        if (this.listening !== listening) return;
        void this.enqueue(async () => this.fail(error));
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
