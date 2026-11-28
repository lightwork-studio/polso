import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { ADMIN_USAGE, runAdmin, UsageError } from "./admin.ts";
import { type Config, ConfigError, readConfig } from "./config.ts";
import { LockedError, lockDataDirectory } from "./lock.ts";
import { createSyncServer } from "./server.ts";
import { DATABASE_FILE, Store } from "./store.ts";

/*
 * The self-hosted Polso server: one Node process and one SQLite database.
 *
 *   polso-server serve            runs the server (the default)
 *   polso-server admin <command>  pairs phones and manages the data (see ADMIN_USAGE)
 */

function prepareDirectory(config: Config): void {
  // Everything the server writes is for its own user only.
  process.umask(process.umask() | 0o077);
  mkdirSync(config.directory, { recursive: true, mode: 0o700 });
}

const openStore = (config: Config) => Store.open(join(config.directory, DATABASE_FILE));

function serve(config: Config): void {
  prepareDirectory(config);
  // Taken before the database opens, so two servers never migrate it at once.
  const unlock = lockDataDirectory(config.directory);
  let store: Store;
  try {
    store = openStore(config);
  } catch (error) {
    unlock();
    throw error;
  }
  const server = createSyncServer({
    store,
    pairing: config.pairing,
    onError: (error) => console.error("Request failed:", error),
  });
  server.listen(config.port, config.host, () => {
    console.log(`Polso server listening on http://${config.host}:${config.port}`);
    if (!config.publicUrl) console.warn("POLSO_PUBLIC_URL isn't set, so phones can't pair yet.");
  });
  const stop = () => {
    server.close(() => {
      store.close();
      unlock();
      process.exit(0);
    });
    server.closeAllConnections();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function main(argv: readonly string[]): number {
  const [command = "serve", ...rest] = argv;
  try {
    const config = readConfig(process.env);
    if (command === "serve") {
      serve(config);
      return -1;
    }
    if (command === "admin") {
      prepareDirectory(config);
      const store = openStore(config);
      try {
        console.log(runAdmin(rest, store, config));
      } finally {
        store.close();
      }
      return 0;
    }
    console.error(`Usage: polso-server [serve | admin <command>]\n\n${ADMIN_USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof UsageError || error instanceof ConfigError) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof LockedError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

const code = main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
