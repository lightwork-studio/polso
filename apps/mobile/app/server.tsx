import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SyncError } from "../src/sync/client";
import type { SyncView } from "../src/sync/controller";
import { hostOf, parsePairingLink } from "../src/sync/link";
import { syncController } from "../src/sync/runtime";
import { Button, useColors } from "../src/ui/theme";

function statusText(view: SyncView): string {
  switch (view.status.name) {
    case "unpaired":
      return "Not paired.";
    case "syncing":
      return view.status.sent > 0
        ? `Sending… ${view.status.sent.toLocaleString()} records so far.`
        : "Sending…";
    case "failed":
      return view.status.message;
    case "idle":
      return view.lastSyncAt
        ? `Up to date as of ${new Date(view.lastSyncAt).toLocaleString()}.`
        : "Not sent yet.";
  }
}

export default function Server() {
  const colors = useColors();
  const view = useSyncExternalStore(syncController.subscribe, syncController.getView);
  const [problem, setProblem] = useState<string>();
  const text = { color: colors.text };
  const muted = { color: colors.muted };
  const warning = { color: colors.accent };

  useEffect(() => {
    syncController
      .load()
      .catch(() => setProblem("Couldn't read the pairing from the Keychain. Unlock the phone."));
  }, []);

  const pasteLink = async () => {
    setProblem(undefined);
    const link = parsePairingLink(await Clipboard.getStringAsync());
    if (!link) {
      setProblem(
        "The clipboard doesn't hold a pairing link. Copy the whole https://…/pair#… link.",
      );
      return;
    }
    router.push({ pathname: "/pair", params: { server: link.server, code: link.code } });
  };

  const unpair = (erase: boolean) => {
    setProblem(undefined);
    syncController.unpair(erase).then(
      (result) => {
        if (result === "server-forgot-phone") {
          setProblem(
            "Unpaired. The server no longer knew this phone, so Polso couldn't erase its copy; whoever runs it can, with polso-server admin erase.",
          );
        }
      },
      (error: unknown) =>
        setProblem(
          `Nothing changed. ${error instanceof SyncError ? error.message : "Polso couldn't forget the server."}`,
        ),
    );
  };

  const confirmUnpair = () =>
    Alert.alert(
      "Unpair this server?",
      "Polso stops sending data at once. The server keeps its copy unless you erase it too.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Unpair", onPress: () => unpair(false) },
        { text: "Erase its copy and unpair", style: "destructive", onPress: () => unpair(true) },
      ],
    );

  const resend = () =>
    Alert.alert(
      "Send everything again?",
      "The server's copy is erased first, then Polso sends your whole history. This can take a while.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send again",
          onPress: () =>
            syncController
              .resendEverything()
              .catch(() => setProblem("Couldn't reset this phone's progress. Try again.")),
        },
      ],
    );

  if (!view.server) {
    return (
      <ScrollView
        style={{ backgroundColor: colors.background }}
        contentContainerStyle={styles.content}
      >
        <Text style={[styles.body, text]}>
          Polso can copy your Health data to a server you run, so your agents can read it around the
          clock, even while this phone is asleep.
        </Text>
        <Text style={[styles.note, muted]}>
          Set up the Polso server, make a pairing link with polso-server admin pair, and open it on
          this iPhone. Or copy the link and paste it here.
        </Text>
        {problem ? <Text style={[styles.note, warning]}>{problem}</Text> : null}
        <Button label="Paste pairing link" onPress={() => void pasteLink()} colors={colors} />
      </ScrollView>
    );
  }

  const syncing = view.status.name === "syncing";
  return (
    <ScrollView
      style={{ backgroundColor: colors.background }}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, text]}>{hostOf(view.server)}</Text>
      <Text style={[styles.body, view.status.name === "failed" ? warning : text]}>
        {statusText(view)}
      </Text>
      {view.skipped && view.status.name === "idle" ? (
        <Text style={[styles.note, warning]}>Not sent: {view.skipped}</Text>
      ) : null}
      <Text style={[styles.note, muted]}>
        Polso sends what changed whenever it opens. While it's closed, the server keeps answering
        agents with what it has.
      </Text>
      {problem ? <Text style={[styles.note, warning]}>{problem}</Text> : null}
      <View style={styles.buttons}>
        <Button
          label="Sync now"
          onPress={() => void syncController.sync()}
          colors={colors}
          disabled={syncing}
        />
        <Button label="Send everything again" onPress={resend} colors={colors} secondary />
        <Button label="Unpair" onPress={confirmUnpair} colors={colors} secondary />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 16, paddingBottom: 48 },
  title: { fontSize: 22, fontWeight: "600" },
  body: { fontSize: 17, lineHeight: 24 },
  note: { fontSize: 14, lineHeight: 20 },
  buttons: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
});
