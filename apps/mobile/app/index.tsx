import { ScrollView, StyleSheet, Text } from "react-native";

export default function Home() {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Text style={styles.body}>
        Polso will give your AI agents read access to the Apple Health data you choose.
      </Text>
      <Text style={styles.note}>Health access is coming in the next build.</Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  body: { fontSize: 17, lineHeight: 24, color: "#8E8E93" },
  note: { fontSize: 15, color: "#8E8E93" },
});
