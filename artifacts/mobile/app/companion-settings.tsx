import React, { useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
    } finally {
      setSaving(false);
    }
  };

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
        <View style={styles.backBtn} />
      </View>

      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={insets.top + 56}
      >
        <ScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: insets.bottom + 32 },
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Name
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Empiri"
              placeholderTextColor={colors.mutedForeground}
              maxLength={NAME_MAX}
              style={[
                styles.input,
                {
                  backgroundColor: colors.card,
                  borderColor: colors.border,
                  color: colors.foreground,
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
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
                    <View style={styles.toneText}>
                      <Text
                        style={[styles.toneLabel, { color: colors.foreground }]}
                      >
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
                );
              })}
            </View>
          </View>

          <View style={styles.section}>
            <Text style={[styles.sectionLabel, { color: colors.mutedForeground }]}>
              Personal touch
            </Text>
            <TextInput
              value={note}
              onChangeText={setNote}
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
                },
              ]}
            />
            <Text style={[styles.hint, { color: colors.mutedForeground }]}>
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
              },
            ]}
          >
            {saving ? (
              <ActivityIndicator color={colors.primaryForeground} />
            ) : (
              <Text
                style={[styles.saveText, { color: colors.primaryForeground }]}
              >
                Save changes
              </Text>
            )}
          </TouchableOpacity>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: "700",
  },
  content: {
    paddingHorizontal: 24,
    paddingTop: 28,
    gap: 28,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
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
  },
});
