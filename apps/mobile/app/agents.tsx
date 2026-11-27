import * as Clipboard from "expo-clipboard";
import { addNetworkStateListener, getIpAddressAsync } from "expo-network";
import { type ReactNode, useEffect, useState, useSyncExternalStore } from "react";
import { Alert, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { MCP_PORT } from "../src/mcp/access";
import { agentAccess } from "../src/mcp/runtime";
import { claudeCodeCommand, endpointUrl, jsonConfig } from "../src/mcp/setup";
import { Button, type Colors, useColors } from "../src/ui/theme";

function useAddress(active: boolean): string | undefined {
  const [address, setAddress] = useState<string>();
  useEffect(() => {
    if (!active) return;
    let current = true;
    const refresh = () =>
      getIpAddressAsync().then(
        (ip) => current && setAddress(ip),
        () => current && setAddress(undefined),
      );
    void refresh();
    const subscription = addNetworkStateListener(() => void refresh());
    return () => {
      current = false;
      subscription.remove();
    };
  }, [active]);
  return active ? address : undefined;
}

const STATUS_TEXT = {
  off: "Off. Nothing on your network can reach Polso.",
  paused: "Paused while Polso is in the background.",
  starting: "Starting…",
  on: "On while Polso stays open and in front. The screen stays awake until you switch access off.",
} as const;

export default function Agents() {
  const colors = useColors();
  const state = useSyncExternalStore(agentAccess.subscribe, agentAccess.getState);
  const { status, token } = state;
  const url = endpointUrl(useAddress(status.name === "on"));
  const [copied, setCopied] = useState<string>();
  const [tokenProblem, setTokenProblem] = useState(false);

  useEffect(() => {
    void agentAccess.loadToken().then(
      () => setTokenProblem(false),
      () => setTokenProblem(true),
    );
  }, []);
  // A token that loads later (say, on switching on) settles an earlier Keychain failure.
  useEffect(() => {
    if (token) setTokenProblem(false);
  }, [token]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(undefined), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = (what: string, text: string) =>
    void Clipboard.setStringAsync(text).then(
      () => setCopied(`Copied the ${what}.`),
      () => setCopied(`Couldn't copy the ${what}.`),
    );

  const regenerate = () =>
    Alert.alert("Make a new token?", "Agents using the current token lose access.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "New token",
        style: "destructive",
        onPress: () => void agentAccess.regenerate().catch(() => undefined),
      },
    ]);

  const text = { color: colors.text };
  const muted = { color: colors.muted };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.body, text]}>
        Let AI agents on your network read your Health data over MCP while Polso is open.
      </Text>

      <View style={[styles.switchRow, { borderColor: colors.separator }]}>
        <Text style={[styles.body, text, styles.grow]}>Agent access</Text>
        <Switch
          accessibilityLabel="Agent access"
          value={state.enabled}
          disabled={status.name === "starting"}
          onValueChange={(on) => void agentAccess.setEnabled(on).catch(() => undefined)}
        />
      </View>
      <Text style={[styles.note, status.name === "failed" ? { color: colors.accent } : muted]}>
        {status.name === "failed"
          ? `Agent access stopped: ${status.message}`
          : STATUS_TEXT[status.name]}
      </Text>

      <Section title="Address" colors={colors}>
        {status.name !== "on" ? (
          <Text style={[styles.note, muted]}>Shown while agent access is on.</Text>
        ) : url ? (
          <>
            <Text style={[styles.mono, text]} selectable>
              {url}
            </Text>
            <Button
              label="Copy address"
              secondary
              onPress={() => copy("address", url)}
              colors={colors}
            />
          </>
        ) : (
          <Text style={[styles.note, muted]}>
            Join a Wi-Fi network to get an address. Over Tailscale, use the phone's Tailscale
            address with port {MCP_PORT} and the path /mcp.
          </Text>
        )}
      </Section>

      <Section title="Token" colors={colors}>
        <Text style={[styles.note, muted]}>
          Agents send it with every request. Anyone who has it can read your Health data while
          access is on.
        </Text>
        {token ? (
          <Text style={[styles.mono, text]}>{`••••••••${token.slice(-4)}`}</Text>
        ) : (
          <Text style={[styles.note, tokenProblem ? { color: colors.accent } : muted]}>
            {tokenProblem
              ? "Couldn't read the token from the Keychain. Unlock the phone and open this screen again."
              : state.status.name === "failed"
                ? "No token. Switch access on to make a new one."
                : "Loading…"}
          </Text>
        )}
        <View style={styles.buttons}>
          <Button
            label="Copy token"
            secondary
            disabled={!token}
            onPress={() => token && copy("token", token)}
            colors={colors}
          />
          <Button label="New token" secondary onPress={regenerate} colors={colors} />
        </View>
      </Section>

      <Section title="Set up an agent" colors={colors}>
        <View style={styles.buttons}>
          <Button
            label="Copy Claude Code command"
            secondary
            disabled={!url || !token}
            onPress={() => url && token && copy("command", claudeCodeCommand(url, token))}
            colors={colors}
          />
          <Button
            label="Copy JSON config"
            secondary
            disabled={!url || !token}
            onPress={() => url && token && copy("config", jsonConfig(url, token))}
            colors={colors}
          />
        </View>
        {copied && <Text style={[styles.note, muted]}>{copied}</Text>}
      </Section>

      <Text style={[styles.note, muted]}>
        Requests travel unencrypted. Use agent access on your own Wi-Fi, or through Tailscale on any
        other network. Agents can only read, never change, your Health data, and web pages can't
        reach Polso.
      </Text>
    </ScrollView>
  );
}

function Section({
  title,
  colors,
  children,
}: {
  title: string;
  colors: Colors;
  children: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: colors.muted }]}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12, paddingBottom: 48 },
  body: { fontSize: 17, lineHeight: 24 },
  note: { fontSize: 14, lineHeight: 20 },
  grow: { flex: 1 },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  section: { gap: 10, paddingTop: 16 },
  sectionTitle: { fontSize: 13 },
  mono: { fontSize: 15, fontFamily: "Menlo" },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
