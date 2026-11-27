import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, SectionList, StyleSheet, Text, View } from "react-native";
import { GROUP_ORDER, groupOf, HEALTH_TYPES, type HealthType } from "../src/health/catalog";
import { formatDay } from "../src/health/format";
import { healthKit } from "../src/health/healthkit";
import {
  needsReadAccess,
  type Preview,
  readPreviews,
  requestReadAccess,
} from "../src/health/reader";
import { previewLabel, summarize } from "../src/health/summary";
import { Button, type Colors, useColors } from "../src/ui/theme";

type Phase =
  | { name: "checking" }
  | { name: "unsupported" }
  | { name: "needsAccess" }
  | { name: "reading"; done: number; total: number }
  | { name: "done"; previews: Map<string, Preview> }
  | { name: "failed"; message: string };

export default function Home() {
  const colors = useColors();
  const [phase, setPhase] = useState<Phase>({ name: "checking" });

  const read = useCallback(async () => {
    setPhase({ name: "reading", done: 0, total: 0 });
    const previews = await readPreviews(healthKit, HEALTH_TYPES, {
      onProgress: (done, total) => setPhase({ name: "reading", done, total }),
    });
    setPhase({ name: "done", previews });
  }, []);

  // One action at a time, so a double tap can't show the permission sheet twice.
  const busy = useRef(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      await action();
    } catch (error) {
      setPhase({ name: "failed", message: error instanceof Error ? error.message : String(error) });
    } finally {
      busy.current = false;
    }
  }, []);

  useEffect(() => {
    void run(async () => {
      if (!healthKit.isHealthDataAvailable()) return setPhase({ name: "unsupported" });
      if (await needsReadAccess(healthKit, HEALTH_TYPES)) return setPhase({ name: "needsAccess" });
      await read();
    });
  }, [read, run]);

  const allow = () =>
    run(async () => {
      setPhase({ name: "checking" });
      await requestReadAccess(healthKit, HEALTH_TYPES);
      await read();
    });

  const sections = useMemo(() => {
    if (phase.name !== "done") return [];
    return GROUP_ORDER.map((title) => ({
      title,
      data: HEALTH_TYPES.filter((t) => groupOf(t) === title && phase.previews.has(t.id)),
    })).filter((s) => s.data.length > 0);
  }, [phase]);

  const text = { color: colors.text };
  const muted = { color: colors.muted };

  if (phase.name === "done") {
    const summary = summarize(phase.previews);
    return (
      <SectionList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.background }}
        sections={sections}
        keyExtractor={(item) => item.id}
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={[styles.body, text]}>
              {summary.withData} of {summary.requested} types have data.
            </Text>
            <Text style={[styles.note, muted]}>
              Health doesn't tell apps which types you declined, so those show as No data. You can
              change access in Settings › Health › Data Access & Devices › Polso.
            </Text>
            <Button label="Read again" onPress={() => run(read)} colors={colors} />
          </View>
        }
        renderSectionHeader={({ section }) => (
          <Text style={[styles.sectionTitle, muted]}>{section.title.toUpperCase()}</Text>
        )}
        renderItem={({ item }) => (
          <Row type={item} preview={phase.previews.get(item.id)} colors={colors} />
        )}
      />
    );
  }

  return (
    <View style={[styles.center, { backgroundColor: colors.background }]}>
      {phase.name === "checking" && <ActivityIndicator />}
      {phase.name === "unsupported" && (
        <Text style={[styles.body, text]}>Health data isn't available on this device.</Text>
      )}
      {phase.name === "needsAccess" && (
        <>
          <Text style={[styles.body, text]}>
            Polso reads the Health data you choose, so your AI agents can answer questions about it.
            It never writes to Health.
          </Text>
          <Button label="Choose Health data" onPress={allow} colors={colors} />
        </>
      )}
      {phase.name === "reading" && (
        <>
          <ActivityIndicator />
          <Text style={[styles.note, muted]}>
            {phase.total > 0 ? `Reading ${phase.done} of ${phase.total} types` : "Reading"}
          </Text>
        </>
      )}
      {phase.name === "failed" && (
        <>
          <Text style={[styles.body, text]}>Polso couldn't read Health data.</Text>
          <Text style={[styles.note, muted]}>{phase.message}</Text>
          <Button label="Try again" onPress={allow} colors={colors} />
        </>
      )}
    </View>
  );
}

function Row({ type, preview, colors }: { type: HealthType; preview?: Preview; colors: Colors }) {
  const hasValue = preview?.status === "value";
  const date = hasValue && preview.date ? formatDay(preview.date) : undefined;
  return (
    <View style={[styles.row, { borderColor: colors.separator }]}>
      <Text style={[styles.rowLabel, { color: colors.text }]} numberOfLines={2}>
        {type.label}
      </Text>
      <View style={styles.rowValue}>
        <Text style={{ color: hasValue ? colors.text : colors.muted }} numberOfLines={1}>
          {preview ? previewLabel(preview) : ""}
        </Text>
        {date && <Text style={[styles.date, { color: colors.muted }]}>{date}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: "center", padding: 24, gap: 16 },
  header: { padding: 20, gap: 12 },
  body: { fontSize: 17, lineHeight: 24 },
  note: { fontSize: 14, lineHeight: 20 },
  sectionTitle: { fontSize: 13, paddingHorizontal: 20, paddingTop: 24, paddingBottom: 6 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { flex: 1, fontSize: 16 },
  rowValue: { alignItems: "flex-end", maxWidth: "50%" },
  date: { fontSize: 12, marginTop: 2 },
});
