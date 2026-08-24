import {
<<<<<<< HEAD
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Stack, useRouter, useSegments } from "expo-router";
=======
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from "@expo-google-fonts/plus-jakarta-sans";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { setAuthTokenGetter, setBaseUrl } from "@workspace/api-client-react";
import { Stack } from "expo-router";
>>>>>>> origin/main
import * as SecureStore from "expo-secure-store";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
<<<<<<< HEAD
import { CompanionProvider } from "@/context/CompanionContext";
import { AuthProvider, useAuth } from "@/lib/auth";

const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);
setAuthTokenGetter(() => SecureStore.getItemAsync("auth_session_token"));

=======
import { CompanionProvider } from "@/contexts/CompanionContext";
import { AUTH_TOKEN_KEY, AuthProvider } from "@/lib/auth";

// Expo bundles run outside the web proxy and need absolute URLs to reach the API.
const domain = process.env.EXPO_PUBLIC_DOMAIN;
if (domain) setBaseUrl(`https://${domain}`);

// Attach the session token as a Bearer header on every API call.
setAuthTokenGetter(() => SecureStore.getItemAsync(AUTH_TOKEN_KEY));

// Prevent the splash screen from auto-hiding before asset loading is complete.
>>>>>>> origin/main
SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient();

function RootLayoutNav() {
<<<<<<< HEAD
  const { isLoading, isAuthenticated } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (isLoading) return;
    const inSignIn = segments[0] === "sign-in";
    if (!isAuthenticated && !inSignIn) {
      router.replace("/sign-in");
    } else if (isAuthenticated && inSignIn) {
      router.replace("/");
    }
  }, [isLoading, isAuthenticated, segments, router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="profile" />
      <Stack.Screen name="companion-settings" />
=======
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="index" />
      <Stack.Screen name="companion-settings" />
      <Stack.Screen name="evolution-log" />
>>>>>>> origin/main
    </Stack>
  );
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
<<<<<<< HEAD
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
=======
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
>>>>>>> origin/main
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <ErrorBoundary>
        <QueryClientProvider client={queryClient}>
<<<<<<< HEAD
          <GestureHandlerRootView style={{ flex: 1 }}>
=======
          <GestureHandlerRootView>
>>>>>>> origin/main
            <KeyboardProvider>
              <AuthProvider>
                <CompanionProvider>
                  <RootLayoutNav />
                </CompanionProvider>
              </AuthProvider>
            </KeyboardProvider>
          </GestureHandlerRootView>
        </QueryClientProvider>
      </ErrorBoundary>
    </SafeAreaProvider>
  );
}
