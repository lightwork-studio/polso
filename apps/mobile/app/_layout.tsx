import { Link, Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { AppState, Text } from "react-native";
import { agentAccess } from "../src/mcp/runtime";
import { syncController } from "../src/sync/runtime";
import { useColors } from "../src/ui/theme";

export default function RootLayout() {
  const colors = useColors();

  useEffect(() => {
    // A paired phone sends what changed when Polso starts and whenever it comes to the front.
    void syncController.sync();
    const subscription = AppState.addEventListener("change", (state) => {
      // Agent access serves only while Polso is in front; iOS suspends it soon after it leaves.
      // "inactive" (Control Center, an incoming call) doesn't count as leaving.
      void agentAccess.setForeground(state !== "background");
      if (state === "active") void syncController.sync();
    });
    return () => subscription.remove();
  }, []);

  const headerLink = (href: "/agents" | "/server", label: string) => () => (
    <Link href={href} accessibilityRole="button">
      <Text style={{ color: colors.text, fontSize: 17 }}>{label}</Text>
    </Link>
  );

  return (
    <>
      <StatusBar style="auto" />
      <Stack screenOptions={{ headerLargeTitle: true }}>
        <Stack.Screen
          name="index"
          options={{
            title: "Polso",
            headerLeft: headerLink("/server", "Server"),
            headerRight: headerLink("/agents", "Agents"),
          }}
        />
        <Stack.Screen name="agents" options={{ title: "Agent access" }} />
        <Stack.Screen name="server" options={{ title: "Your server" }} />
        <Stack.Screen name="pair" options={{ title: "Pair", headerLargeTitle: false }} />
      </Stack>
    </>
  );
}
