/** Settings from the environment; see the README. */
export interface Config {
  readonly directory: string;
  readonly publicUrl?: string;
  readonly host: string;
  readonly port: number;
  readonly pairing: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function readConfig(env: NodeJS.ProcessEnv): Config {
  // Polso's own names: shells and platforms set HOST and PORT for other purposes.
  const port = Number(env.POLSO_PORT ?? 8788);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`POLSO_PORT must be a port number, not ${env.POLSO_PORT}.`);
  }
  let publicUrl: string | undefined;
  if (env.POLSO_PUBLIC_URL) {
    let url: URL;
    try {
      url = new URL(env.POLSO_PUBLIC_URL);
    } catch {
      throw new ConfigError("POLSO_PUBLIC_URL must be a URL, such as https://polso.example.com.");
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      throw new ConfigError("POLSO_PUBLIC_URL must use https, so tokens never cross in the clear.");
    }
    if (url.search || url.hash || url.username || url.password) {
      throw new ConfigError("POLSO_PUBLIC_URL must not have a query, fragment or credentials.");
    }
    // The pairing page tells the app the server's origin, so the server can't live under a path.
    if (url.pathname !== "/") {
      throw new ConfigError("POLSO_PUBLIC_URL must be the server's root, without a path.");
    }
    publicUrl = url.href.replace(/\/$/, "");
  }
  const pairing = env.POLSO_PAIRING ?? "on";
  if (pairing !== "on" && pairing !== "off") {
    throw new ConfigError("POLSO_PAIRING must be on or off.");
  }
  return {
    directory: env.POLSO_DATA ?? "./data",
    ...(publicUrl !== undefined && { publicUrl }),
    host: env.POLSO_HOST ?? "127.0.0.1",
    port,
    pairing: pairing === "on",
  };
}
