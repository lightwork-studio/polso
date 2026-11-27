import { Pressable, StyleSheet, Text, useColorScheme } from "react-native";

// The icon's palette: paper, ink and a red dot.
const lightColors = {
  background: "#F2EDE4",
  text: "#1A1A1E",
  muted: "#6E6A64",
  separator: "#DDD6CA",
  accent: "#D33A2C",
};
const darkColors: Colors = {
  background: "#1A1A1E",
  text: "#F2EDE4",
  muted: "#9C978F",
  separator: "#34343A",
  accent: "#E5574A",
};
export type Colors = typeof lightColors;

export function useColors(): Colors {
  return useColorScheme() === "dark" ? darkColors : lightColors;
}

export function Button({
  label,
  onPress,
  colors,
  secondary = false,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  colors: Colors;
  secondary?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary
          ? { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.text }
          : { backgroundColor: colors.text },
        { opacity: disabled ? 0.4 : pressed ? 0.7 : 1 },
      ]}
    >
      <Text style={[styles.label, { color: secondary ? colors.text : colors.background }]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { alignSelf: "flex-start", borderRadius: 12, paddingHorizontal: 18, paddingVertical: 12 },
  label: { fontSize: 16, fontWeight: "600" },
});
