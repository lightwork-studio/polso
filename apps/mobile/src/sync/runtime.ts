import { randomUUID } from "expo-crypto";
import { File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { healthKitSync } from "../health/healthkit";
import { httpClient } from "./client";
import { type Pairing, SyncController } from "./controller";
import type { SyncState } from "./engine";

const PAIRING_KEY = "polso.sync.pairing";
// Readable after the first unlock since the phone started, so a sync iOS starts in the
// background can use it; never restored to another device from a backup.
const keychain = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const stateFile = () => new File(Paths.document, "sync-state.json");

function isPairing(value: unknown): value is Pairing {
  const p = value as Partial<Pairing> | null;
  return typeof p?.server === "string" && typeof p.token === "string" && typeof p.id === "string";
}

/** The app's one sync controller. */
export const syncController = new SyncController({
  async loadPairing() {
    const text = await SecureStore.getItemAsync(PAIRING_KEY, keychain);
    if (!text) return null;
    try {
      const value: unknown = JSON.parse(text);
      return isPairing(value) ? value : null;
    } catch {
      return null;
    }
  },
  savePairing: (pairing) =>
    SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(pairing), keychain),
  deletePairing: () => SecureStore.deleteItemAsync(PAIRING_KEY, keychain),

  async loadState(pairingId) {
    const file = stateFile();
    if (!file.exists) return { anchors: {} };
    try {
      const saved = JSON.parse(await file.text()) as { pairing?: string; state?: SyncState };
      return saved.pairing === pairingId && saved.state ? saved.state : { anchors: {} };
    } catch {
      return { anchors: {} };
    }
  },
  async saveState(pairingId, state) {
    const file = stateFile();
    if (!file.exists) file.create();
    file.write(JSON.stringify({ pairing: pairingId, state }));
  },
  async deleteState() {
    const file = stateFile();
    if (file.exists) file.delete();
  },

  client: (server, token) => httpClient(server, token),
  source: healthKitSync,
  randomId: randomUUID,
  deviceName: "iPhone",
});
