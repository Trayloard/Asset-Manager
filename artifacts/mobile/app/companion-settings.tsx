<<<<<<< HEAD
import React, { useState } from "react";
=======
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Redirect, useRouter } from "expo-router";
import React, { useEffect, useState } from "react";
>>>>>>> origin/main
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
<<<<<<< HEAD
=======
  Pressable,
>>>>>>> origin/main
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
<<<<<<< HEAD
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { useCompanion } from "@/context/CompanionContext";

const TONE_PRESETS: { id: string; label: string; blurb: string }[] = [
  { id: "playful", label: "Playful", blurb: "Curious and full of whimsy" },
  { id: "calm", label: "Calm", blurb: "Gentle and soothing" },
  { id: "witty", label: "Witty", blurb: "Clever and quick with a joke" },
  { id: "wise", label: "Wise", blurb: "Thoughtful and encouraging" },
  { id: "cheerful", label: "Cheerful", blurb: "Upbeat and enthusiastic" },
];

const NAME_MAX = 40;
const NOTE_MAX = 280;

export default function CompanionSettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { settings, saveSettings } = useCompanion();

  const [name, setName] = useState(settings.name);
  const [tone, setTone] = useState(settings.tone);
  const [note, setNote] = useState(settings.personalityNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleBack = () => {
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/profile");
    }
  };

  const trimmedName = name.trim();
  const canSave = trimmedName.length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await saveSettings({
        name: trimmedName,
        tone,
        personalityNote: note.trim() ? note.trim() : null,
      });
      handleBack();
    } catch {
      setError("Couldn't save your changes. Please try again.");
=======
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FONTS } from "@/constants/fonts";
import { useCompanion } from "@/contexts/CompanionContext";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";

const TONE_OPTIONS = [
  {
    value: "calm" as const,
    label: "Calm",
    description: "Gentle, steady, and warm.",
    icon: "cloud" as const,
  },
  {
    value: "playful" as const,
    label: "Playful",
    description: "Lighthearted, fun, and full of wordplay.",
    icon: "smile" as const,
  },
  {
    value: "witty" as const,
    label: "Witty",
    description: "Clever and a little sharp.",
    icon: "zap" as const,
  },
  {
    value: "wise" as const,
    label: "Wise",
    description: "Thoughtful, reflective, and a bit philosophical.",
    icon: "book-open" as const,
  },
  {
    value: "cheerful" as const,
    label: "Cheerful",
    description: "Bright, uplifting, and encouraging.",
    icon: "sun" as const,
  },
];

type ToneValue = (typeof TONE_OPTIONS)[number]["value"];

export default function CompanionSettingsScreen() {
  const router = useRouter();
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { settings, saveSettings } = useCompanion();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [name, setName] = useState(settings?.companionName ?? "Empiri");
  const [tone, setTone] = useState<ToneValue>(
    (settings?.tone as ToneValue) ?? "calm",
  );
  const [note, setNote] = useState(settings?.personalityNote ?? "");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Keep local state in sync when settings load (e.g. loaded async after render).
  useEffect(() => {
    if (settings) {
      setName(settings.companionName);
      setTone(settings.tone as ToneValue);
      setNote(settings.personalityNote);
    }
  }, [settings]);

  const handleSave = async () => {
    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    setSaving(true);
    try {
      await saveSettings({
        companionName: name.trim() || "Empiri",
        tone,
        personalityNote: note,
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
>>>>>>> origin/main
    } finally {
      setSaving(false);
    }
  };

<<<<<<< HEAD
  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <View
        style={[
          styles.header,
          { paddingTop: insets.top + 8, borderBottomColor: colors.border },
        ]}
      >
        <TouchableOpacity
          onPress={handleBack}
          style={styles.backBtn}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <Feather name="chevron-left" size={24} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Companion
        </Text>
=======
  // Same auth pattern as the main chat screen: wait for the auth check,
  // then send signed-out users to the root screen, which shows the login gate.
  if (authLoading) {
    return (
      <View style={[styles.root, styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    );
  }

  if (!isAuthenticated) {
    return <Redirect href="/" />;
  }

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          {
            paddingTop: insets.top + 10,
            borderBottomColor: colors.border,
          },
        ]}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={12}
          style={({ pressed }) => [
            styles.backBtn,
            { backgroundColor: colors.muted, opacity: pressed ? 0.6 : 1 },
          ]}
        >
          <Feather name="arrow-left" size={20} color={colors.foreground} />
        </Pressable>

        <Text style={[styles.headerTitle, { color: colors.foreground }]}>
          Personalize
        </Text>

        {/* Spacer to center title */}
>>>>>>> origin/main
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
<<<<<<< HEAD
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 56}
=======
        behavior={Platform.OS === "ios" ? "padding" : "height"}
>>>>>>> origin/main
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 32 },
          ]}
<<<<<<< HEAD
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Name
=======
          keyboardShouldPersistTaps="handled"
        >
          {/* Name */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Name your companion
>>>>>>> origin/main
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Empiri"
              placeholderTextColor={colors.mutedForeground}
<<<<<<< HEAD
              maxLength={NAME_MAX}
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
=======
              maxLength={32}
              autoCapitalize="words"
              style={[
                styles.input,
                {
                  color: colors.foreground,
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
>>>>>>> origin/main
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
<<<<<<< HEAD
              What would you like to call your companion?
            </Text>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Personality
            </Text>
            <View style={styles.toneList}>
              {TONE_PRESETS.map((preset) => {
                const selected = preset.id === tone;
                return (
                  <TouchableOpacity
                    key={preset.id}
                    activeOpacity={0.85}
                    onPress={() => setTone(preset.id)}
                    style={[
                      styles.toneCard,
                      {
                        backgroundColor: colors.card,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                  >
=======
              This name appears in the tooltip and is used by your companion.
            </Text>
          </View>

          {/* Tone */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Conversation tone
            </Text>
            <View style={styles.toneList}>
              {TONE_OPTIONS.map((opt) => {
                const active = opt.value === tone;
                return (
                  <Pressable
                    key={opt.value}
                    onPress={() => {
                      if (Platform.OS !== "web")
                        Haptics.selectionAsync().catch(() => {});
                      setTone(opt.value);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={`${opt.label}. ${opt.description}`}
                    style={({ pressed }) => [
                      styles.toneOption,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active ? colors.muted : "transparent",
                        opacity: pressed ? 0.7 : 1,
                      },
                    ]}
                  >
                    <Feather
                      name={opt.icon}
                      size={18}
                      color={active ? colors.primary : colors.mutedForeground}
                      style={styles.toneIcon}
                    />
>>>>>>> origin/main
                    <View style={styles.toneText}>
                      <Text
                        style={[styles.toneLabel, { color: colors.foreground }]}
                      >
<<<<<<< HEAD
                        {preset.label}
                      </Text>
                      <Text
                        style={[
                          styles.toneBlurb,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {preset.blurb}
                      </Text>
                    </View>
                    {selected && (
                      <Feather name="check" size={20} color={colors.primary} />
                    )}
                  </TouchableOpacity>
=======
                        {opt.label}
                      </Text>
                      <Text
                        style={[
                          styles.toneDesc,
                          { color: colors.mutedForeground },
                        ]}
                      >
                        {opt.description}
                      </Text>
                    </View>
                    {active ? (
                      <Feather name="check" size={18} color={colors.primary} />
                    ) : (
                      <View style={styles.checkPlaceholder} />
                    )}
                  </Pressable>
>>>>>>> origin/main
                );
              })}
            </View>
          </View>

<<<<<<< HEAD
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Personal touch
=======
          {/* Personality note */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              About you
>>>>>>> origin/main
            </Text>
            <TextInput
              value={note}
              onChangeText={setNote}
<<<<<<< HEAD
              placeholder="e.g. Loves space facts and always cheers me on"
              placeholderTextColor={colors.mutedForeground}
              maxLength={NOTE_MAX}
              multiline
              style={[
                styles.input,
                styles.textArea,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
=======
              placeholder="What should your companion know about you?"
              placeholderTextColor={colors.mutedForeground}
              multiline
              numberOfLines={4}
              maxLength={500}
              style={[
                styles.textarea,
                {
                  color: colors.foreground,
                  backgroundColor: colors.muted,
                  borderColor: colors.border,
>>>>>>> origin/main
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
<<<<<<< HEAD
              Optional — describe quirks or topics your companion should lean
              into. {note.length}/{NOTE_MAX}
            </Text>
          </View>

          {error && (
            <Text style={[styles.error, { color: colors.destructive }]}>
              {error}
            </Text>
          )}

          <TouchableOpacity
            onPress={handleSave}
            activeOpacity={0.85}
            disabled={!canSave}
            style={[
              styles.saveBtn,
              {
                backgroundColor: colors.primary,
                opacity: canSave ? 1 : 0.5,
=======
              {note.length}/500
            </Text>
          </View>

          {/* Evolution log entry point */}
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Growth
            </Text>
            <Pressable
              onPress={() => router.push("/evolution-log")}
              accessibilityRole="button"
              accessibilityLabel="Open the evolution log"
              style={({ pressed }) => [
                styles.linkRow,
                {
                  borderColor: colors.border,
                  backgroundColor: pressed ? colors.muted : "transparent",
                },
              ]}
            >
              <Feather
                name="trending-up"
                size={18}
                color={colors.primary}
                style={styles.linkIcon}
              />
              <View style={styles.linkText}>
                <Text style={[styles.linkLabel, { color: colors.foreground }]}>
                  Evolution log
                </Text>
                <Text style={[styles.linkDesc, { color: colors.mutedForeground }]}>
                  See how your companion has grown over time.
                </Text>
              </View>
              <Feather
                name="chevron-right"
                size={18}
                color={colors.mutedForeground}
              />
            </Pressable>
          </View>

          {/* Save button */}
          <Pressable
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save companion settings"
            style={({ pressed }) => [
              styles.saveBtn,
              {
                backgroundColor: saved ? colors.primary : colors.primary,
                opacity: saving ? 0.6 : pressed ? 0.85 : 1,
>>>>>>> origin/main
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
<<<<<<< HEAD
              <Text
                style={[styles.saveText, { color: colors.primaryForeground }]}
              >
                Save changes
              </Text>
            )}
          </TouchableOpacity>
=======
              <Text style={[styles.saveBtnText, { color: colors.primaryForeground }]}>
                {saved ? "Saved ✓" : "Save"}
              </Text>
            )}
          </Pressable>
>>>>>>> origin/main
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
<<<<<<< HEAD
  screen: {
    flex: 1,
  },
  flex: {
    flex: 1,
=======
  root: { flex: 1 },
  flex: { flex: 1 },
  center: {
    alignItems: "center",
    justifyContent: "center",
>>>>>>> origin/main
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
<<<<<<< HEAD
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
=======
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
>>>>>>> origin/main
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
<<<<<<< HEAD
    fontWeight: "700",
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 28,
=======
    fontFamily: FONTS.semibold,
    letterSpacing: -0.3,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 24,
>>>>>>> origin/main
    gap: 28,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
<<<<<<< HEAD
    fontSize: 12,
    fontWeight: "600",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  input: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
  },
  textArea: {
    minHeight: 96,
    textAlignVertical: "top",
  },
  hint: {
    fontSize: 13,
  },
  toneList: {
    gap: 10,
  },
  toneCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: 14,
    borderWidth: 1.5,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  toneText: {
    flex: 1,
    gap: 3,
  },
  toneLabel: {
    fontSize: 16,
    fontWeight: "600",
  },
  toneBlurb: {
    fontSize: 13,
  },
  error: {
    fontSize: 14,
    textAlign: "center",
  },
  saveBtn: {
    height: 52,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  saveText: {
    fontSize: 16,
    fontWeight: "700",
=======
    fontSize: 11,
    fontFamily: FONTS.semibold,
    letterSpacing: 0.7,
    textTransform: "uppercase",
  },
  input: {
    fontSize: 16,
    fontFamily: FONTS.regular,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
  },
  textarea: {
    fontSize: 15,
    fontFamily: FONTS.regular,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: 110,
    textAlignVertical: "top",
  },
  hint: {
    fontSize: 12,
    fontFamily: FONTS.regular,
    marginTop: 2,
  },
  toneList: {
    gap: 8,
  },
  toneOption: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  toneIcon: {
    marginRight: 12,
  },
  toneText: {
    flex: 1,
  },
  toneLabel: {
    fontSize: 15,
    fontFamily: FONTS.semibold,
    letterSpacing: -0.2,
  },
  toneDesc: {
    fontSize: 12.5,
    fontFamily: FONTS.regular,
    marginTop: 2,
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  linkIcon: {
    marginRight: 12,
  },
  linkText: {
    flex: 1,
  },
  linkLabel: {
    fontSize: 15,
    fontFamily: FONTS.semibold,
    letterSpacing: -0.2,
  },
  linkDesc: {
    fontSize: 12.5,
    fontFamily: FONTS.regular,
    marginTop: 2,
  },
  checkPlaceholder: {
    width: 18,
    height: 18,
  },
  saveBtn: {
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  saveBtnText: {
    fontSize: 16,
    fontFamily: FONTS.semibold,
>>>>>>> origin/main
  },
});
