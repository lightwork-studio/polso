import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { SyncError } from "../src/sync/client";
import { hostOf, parsePairingLink } from "../src/sync/link";
import { syncController } from "../src/sync/runtime";
import { Button, useColors } from "../src/ui/theme";

/**
 * Opened by a pairing link (polso://pair?server=…&code=…). Anyone can make such a link, so
 * nothing happens until the person confirms the server by name.
 */
export default function Pair() {
  const colors = useColors();
  const params = useLocalSearchParams<{ server?: string; code?: string }>();
  const link = parsePairingLink(
    `polso://pair?${new URLSearchParams({
      server: String(params.server ?? ""),
      code: String(params.code ?? ""),
    })}`,
  );
  const current = useSyncExternalStore(syncController.subscribe, syncController.getView).server;
  useEffect(() => {
    void syncController.load().catch(() => undefined);
  }, []);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const text = { color: colors.text };
  const muted = { color: colors.muted };

  if (!link) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.body, text]}>
          This pairing link isn't complete, or its server doesn't use https. Make a new link on the
          server with polso-server admin pair.
        </Text>
      </ScrollView>
    );
  }

  const pair = () => {
    setBusy(true);
    setProblem(undefined);
    syncController.pair(link).then(
      // The first sync runs on; the Server screen shows how far it got.
      () => router.replace("/server"),
      (error: unknown) => {
        setBusy(false);
        setProblem(
          error instanceof SyncError ? error.message : "Couldn't save the pairing on this phone.",
        );
      },
    );
  };

  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, text]}>{hostOf(link.server)}</Text>
      <Text style={[styles.body, text]}>
        Pair with this server? Polso will send it a copy of your Health data, and keep it up to
        date, so agents you give a token can read it.
      </Text>
      <Text style={[styles.note, muted]}>
        Only pair with a server you run or trust: whoever runs it can read everything Polso sends.
        Polso pairs with one server at a time.
      </Text>
      {current && current !== link.server ? (
        <Text style={[styles.note, { color: colors.accent }]}>
          This replaces {hostOf(current)}, which Polso sends your data to now.
        </Text>
      ) : null}
      {problem ? <Text style={[styles.note, { color: colors.accent }]}>{problem}</Text> : null}
      <Button label={busy ? "Pairing…" : "Pair"} onPress={pair} colors={colors} disabled={busy} />
      <Button
        label="Cancel"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        colors={colors}
        secondary
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 16 },
  title: { fontSize: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 24 },
  note: { fontSize: 14, lineHeight: 20 },
});
