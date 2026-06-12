import React, { useRef } from "react";
import {
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatInput } from "@/components/ChatInput";
import { Creature } from "@/components/Creature";
import { DynamicIsland } from "@/components/DynamicIsland";
import { MessageBubble } from "@/components/MessageBubble";
import { useCompanion, Message } from "@/context/CompanionContext";
import { useColors } from "@/hooks/useColors";
import { useAuth } from "@/lib/auth";

export default function HomeScreen() {
  const { messages, creatureState, companionName, isStreaming, sendMessage, clearMessages } =
    useCompanion();
  const colors = useColors();
  const { user, logout } = useAuth();
  const listRef = useRef<FlatList<Message>>(null);

  const firstName = user?.firstName?.trim() || null;
  const initial = (firstName || user?.email || "?").charAt(0).toUpperCase();

  const handleSend = (text: string) => {
    sendMessage(text);
    setTimeout(() => {
      listRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const handleClear = () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    clearMessages();
  };

  const renderEmpty = () => (
    <View style={styles.emptyContainer}>
      <Creature state={creatureState} size={200} />
      <Text style={[styles.emptyTitle, { color: colors.foreground }]}>
        Say hello to Empiri
      </Text>
      <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
        Your AI companion lives in the Dynamic Island above.{"\n"}Tap it to start a conversation.
      </Text>
    </View>
  );

  return (
    <View style={[styles.screen, { backgroundColor: colors.background }]}>
      <DynamicIsland state={creatureState} companionName={companionName} />

      <View style={[styles.headerRow, { borderBottomColor: colors.border }]}>
        <View style={styles.userInfo}>
          {user?.profileImageUrl ? (
            <Image
              source={{ uri: user.profileImageUrl }}
              style={[styles.avatar, { backgroundColor: colors.muted }]}
            />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback, { backgroundColor: colors.muted }]}>
              <Text style={[styles.avatarInitial, { color: colors.mutedForeground }]}>
                {initial}
              </Text>
            </View>
          )}
          <Text style={[styles.userName, { color: colors.foreground }]} numberOfLines={1}>
            {firstName ? `Hi, ${firstName}` : "Welcome"}
          </Text>
        </View>
        <View style={styles.headerActions}>
          {messages.length > 0 && (
            <TouchableOpacity onPress={handleClear} style={styles.clearBtn}>
              <Feather name="trash-2" size={16} color={colors.mutedForeground} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={logout} style={styles.clearBtn}>
            <Feather name="log-out" size={16} color={colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          renderItem={({ item }) => (
            <MessageBubble message={item} companionName={companionName} />
          )}
          ListEmptyComponent={renderEmpty}
          contentContainerStyle={[
            styles.list,
            messages.length === 0 && styles.listEmpty,
          ]}
          onContentSizeChange={() =>
            listRef.current?.scrollToEnd({ animated: true })
          }
          showsVerticalScrollIndicator={false}
        />
        <ChatInput onSend={handleSend} disabled={isStreaming} />
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  userInfo: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
  },
  avatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  avatarFallback: {
    alignItems: "center",
    justifyContent: "center",
  },
  avatarInitial: {
    fontSize: 14,
    fontWeight: "700",
  },
  userName: {
    fontSize: 15,
    fontWeight: "600",
    flexShrink: 1,
  },
  headerActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  clearBtn: {
    padding: 4,
  },
  list: {
    paddingVertical: 12,
    gap: 4,
  },
  listEmpty: {
    flex: 1,
  },
  emptyContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
    gap: 12,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  emptySubtitle: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
});
