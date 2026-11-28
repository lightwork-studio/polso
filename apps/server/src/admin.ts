import type { Config } from "./config.ts";
import type { Store } from "./store.ts";
import { hashSecret, newSecret, PAIRING_CODE_MS } from "./tokens.ts";

export const ADMIN_USAGE = `Usage: polso-server admin <command>

  pair                    one-time pairing link for a phone, valid 15 minutes
  devices list            paired phones and when each was last seen
  devices revoke <id>     unpair one phone; its token stops working at once
  devices revoke --all    unpair every phone and cancel unused pairing links
  agents add <name>       a token for an agent to read the data over MCP (shown once)
  agents list             agents and when each last read
  agents revoke <id>      take one agent's token away; it stops working at once
  agents revoke --all     take every agent's token away
  status                  how much Health data the server holds
  erase --yes             delete every copied Health record (phones stay paired)

Run it as the server's user, with the same POLSO_DATA as the server.`;

export class UsageError extends Error {
  override name = "UsageError";
}

/** Runs one admin command against the database and returns what to print. */
export function runAdmin(
  args: readonly string[],
  store: Store,
  config: Config,
  now = new Date(),
): string {
  const [command, sub, arg] = args;
  switch (command) {
    case "pair": {
      // The server records its settings when it starts, so admin needn't repeat them.
      const publicUrl = config.publicUrl ?? store.setting("publicUrl");
      if (!publicUrl) {
        throw new UsageError(
          "Set POLSO_PUBLIC_URL to the server's https address, and start the server with it.",
        );
      }
      const code = newSecret();
      store.addPairingCode(hashSecret(code), new Date(now.getTime() + PAIRING_CODE_MS));
      const lines = [
        `${publicUrl}/pair#${code}`,
        "",
        "Open this link on the iPhone with Polso, or scan it as a QR code with the camera",
        "(qrencode -t ansiutf8 '<link>'). It works once, within 15 minutes.",
      ];
      if (store.setting("pairing") === "off") {
        lines.push("", "The server runs with POLSO_PAIRING=off: turn pairing on first.");
      }
      return lines.join("\n");
    }
    case "devices": {
      if (sub === "list") {
        const devices = store.devices();
        if (devices.length === 0) return "No paired devices.";
        return devices
          .map(
            (d) =>
              `${d.id}\t${d.name}\tpaired ${d.pairedAt.toISOString()}\tlast seen ${
                d.lastSeenAt?.toISOString() ?? "never"
              }`,
          )
          .join("\n");
      }
      if (sub === "revoke") {
        if (arg === "--all") return `Unpaired ${store.revoke()} device(s).`;
        const id = Number(arg);
        if (!Number.isInteger(id) || id <= 0) {
          throw new UsageError("Name the device by its id from `devices list`, or --all.");
        }
        if (store.revoke(id) === 0) throw new UsageError(`No device ${id}.`);
        return `Unpaired device ${id}.`;
      }
      break;
    }
    case "agents": {
      if (sub === "add") {
        const name = args.slice(2).join(" ").trim();
        if (name === "" || name.length > 100 || /\p{Cc}/u.test(name)) {
          throw new UsageError("Name the agent in 1 to 100 characters: agents add <name>.");
        }
        const token = newSecret();
        const id = store.addAgent(name, hashSecret(token), now);
        const publicUrl = config.publicUrl ?? store.setting("publicUrl") ?? "https://YOUR-SERVER";
        const url = `${publicUrl}/mcp`;
        const json = JSON.stringify(
          {
            mcpServers: {
              polso: { type: "http", url, headers: { Authorization: `Bearer ${token}` } },
            },
          },
          null,
          2,
        );
        return [
          `Agent ${id} (${name}) can read your Health data with this token. It isn't shown again:`,
          "",
          token,
          "",
          "Claude Code:",
          `claude mcp add --transport http polso ${url} --header "Authorization: Bearer ${token}"`,
          "",
          "Other MCP clients:",
          json,
        ].join("\n");
      }
      if (sub === "list") {
        const agents = store.agents();
        if (agents.length === 0) return "No agents.";
        return agents
          .map(
            (a) =>
              `${a.id}\t${a.name}\tadded ${a.createdAt.toISOString()}\tlast read ${
                a.lastUsedAt?.toISOString() ?? "never"
              }`,
          )
          .join("\n");
      }
      if (sub === "revoke") {
        if (arg === "--all") return `Revoked ${store.revokeAgent()} agent token(s).`;
        const id = Number(arg);
        if (!Number.isInteger(id) || id <= 0) {
          throw new UsageError("Name the agent by its id from `agents list`, or --all.");
        }
        if (store.revokeAgent(id) === 0) throw new UsageError(`No agent ${id}.`);
        return `Revoked agent ${id}.`;
      }
      break;
    }
    case "status": {
      const c = store.counts();
      return [
        `Devices: ${store.devices().length}`,
        `Agents: ${store.agents().length}`,
        `Samples: ${c.samples}`,
        `Workouts: ${c.workouts}`,
        `Daily statistics: ${c.dailyStats}`,
        `Last upload: ${c.lastUploadAt ?? "never"}`,
      ].join("\n");
    }
    case "erase": {
      if (sub !== "--yes") {
        throw new UsageError(
          "This deletes every Health record on the server. Run `erase --yes` to go ahead.",
        );
      }
      const before = store.counts();
      store.eraseHealthData();
      return [
        `Erased ${before.samples} samples, ${before.workouts} workouts and ${before.dailyStats} daily statistics.`,
        "Paired phones send their whole history again on their next sync; revoke them first to stop that.",
      ].join("\n");
    }
  }
  throw new UsageError(ADMIN_USAGE);
}
