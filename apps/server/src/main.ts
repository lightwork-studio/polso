import { join } from "node:path";
import { ADMIN_USAGE, runAdmin, UsageError } from "./admin.ts";
import { type Config, ConfigError, readConfig } from "./config.ts";
import { prepareDirectory } from "./files.ts";
import { LockedError, lockDataDirectory } from "./lock.ts";
import { createSyncServer } from "./server.ts";
import { DATABASE_FILE, MissingDatabaseError, Store } from "./store.ts";

/*
 * The self-hosted Polso server: one Node process and one SQLite database.
 *
 *   polso-server serve            runs the server (the default)
 *   polso-server admin <command>  pairs phones and manages the data (see ADMIN_USAGE)
 */

const databasePath = (config: Config) => join(config.directory, DATABASE_FILE);

function serve(config: Config): void {
  prepareDirectory(config.directory);
  // Taken before the database opens, so two servers never migrate it at once.
  const unlock = lockDataDirectory(config.directory);
  let store: Store;
  try {
    store = Store.open(databasePath(config));
    // Recorded for `admin pair`, which runs without the server's environment.
    if (config.publicUrl) store.saveSetting("publicUrl", config.publicUrl);
    store.saveSetting("pairing", config.pairing ? "on" : "off");
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
    if (config.host !== "127.0.0.1" && config.host !== "::1" && config.host !== "localhost") {
      console.warn("It listens beyond this machine over plain HTTP: put HTTPS in front of it.");
    }
    if (!config.publicUrl) {
      console.warn(
        "POLSO_PUBLIC_URL isn't set: `admin pair` uses the address recorded earlier, if any.",
      );
    }
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
      // Only an existing database: a mistyped POLSO_DATA must not erase or revoke nothing.
      const store = Store.open(databasePath(config), { create: false, migrate: false });
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
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof MissingDatabaseError
    ) {
      console.error(error.message);
      return 2;
    }
    if (error instanceof LockedError) {
      console.error(error.message);
      return 1;
    }
    // Anything else (the database busy for too long, say): the message, not a stack trace.
    if (command === "admin" && error instanceof Error) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}

const code = main(process.argv.slice(2));
if (code >= 0) process.exitCode = code;
