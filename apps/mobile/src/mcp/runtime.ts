import Constants from "expo-constants";
import { getRandomBytes } from "expo-crypto";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as SecureStore from "expo-secure-store";
import { HEALTH_TYPES } from "../health/catalog";
import { healthKit, healthQueries } from "../health/healthkit";
import { availableTypes } from "../health/reader";
import { AgentAccess, MCP_PORT } from "./access";
import { Listener } from "./listener";
import { checkHead, type EndpointOptions, handleHttp } from "./server";
import { listenTcp } from "./tcp";

const TOKEN_KEY = "polso.agent-access.token";
const KEEP_AWAKE_TAG = "polso.agent-access";
// Readable only while the phone is unlocked, and never restored to another device from a backup.
const keychain = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

const server = { name: "polso", version: Constants.expoConfig?.version ?? "0.0.0" };
let types: ReturnType<typeof availableTypes> | undefined;
const context: EndpointOptions["context"] = async () => {
  types ??= availableTypes(healthKit, HEALTH_TYPES);
  return { types, queries: healthQueries, now: new Date() };
};

/** The app's one agent-access controller. */
export const agentAccess = new AgentAccess({
  loadToken: () => SecureStore.getItemAsync(TOKEN_KEY, keychain),
  saveToken: (token) => SecureStore.setItemAsync(TOKEN_KEY, token, keychain),
  randomBytes: getRandomBytes,
  listen: (token, onFailure) => {
    const options: EndpointOptions = { token, server, context };
    const listener = new Listener({
      check: (head) => checkHead(head, token),
      handle: (request) => handleHttp(request, options),
    });
    return listenTcp(MCP_PORT, listener, onFailure);
  },
  keepAwake: (on) => {
    const change = on
      ? activateKeepAwakeAsync(KEEP_AWAKE_TAG)
      : deactivateKeepAwake(KEEP_AWAKE_TAG);
    // Keep-awake only helps; access works without it while the screen is on.
    change.catch(() => undefined);
  },
});
