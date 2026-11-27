import { Link, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, Text } from "react-native";
import { agentAccess } from "../src/mcp/runtime";
import { useColors } from "../src/ui/theme";

export default function RootLayout() {
  const colors = useColors();

  // Agent access serves only while Polso is in front; iOS suspends it soon after it leaves.
  // "inactive" (Control Center, an incoming call) doesn't count as leaving.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      void agentAccess.setForeground(state !== "background");
    });
    return () => subscription.remove();
  }, []);

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerLargeTitle: true }}>
        <Stack.Screen
          name="index"
          options={{
            title: "Polso",
            headerRight: () => (
              <Link href="/agents" accessibilityRole="button">
                <Text style={{ color: colors.text, fontSize: 17 }}>Agents</Text>
              </Link>
            ),
          }}
        />
        <Stack.Screen name="agents" options={{ title: "Agent access" }} />
      </Stack>
    </>
  );
}
