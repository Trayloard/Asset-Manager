import React, { useEffect } from "react";
import { View, Text, StyleSheet, Platform } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Message } from "@/context/CompanionContext";
import { useColors } from "@/hooks/useColors";

type Props = {
  message: Message;
  companionName: string;
};

export function MessageBubble({ message, companionName }: Props) {
  const colors = useColors();
  const isUser = message.role === "user";

  const opacity = useSharedValue(0);
  const translateY = useSharedValue(10);

  useEffect(() => {
    opacity.value = withTiming(1, { duration: 300 });
    translateY.value = withSpring(0, { damping: 18, stiffness: 200 });
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  return (
    <Animated.View
      style={[
        styles.row,
        isUser ? styles.rowUser : styles.rowAssistant,
        animStyle,
      ]}
    >
      {!isUser && (
        <View style={[styles.avatar, { backgroundColor: "#00D9FF22" }]}>
          <Text style={[styles.avatarText, { color: "#00D9FF" }]}>L</Text>
        </View>
      )}
      <View
        style={[
          styles.bubble,
          isUser
            ? [styles.userBubble, { backgroundColor: "#00D9FF" }]
            : [styles.assistantBubble, { backgroundColor: colors.card, borderColor: "#0D2A3A" }],
        ]}
      >
        {!isUser && (
          <Text style={[styles.senderName, { color: "#00D9FF" }]}>
            {companionName}
          </Text>
        )}
        <Text
          style={[
            styles.text,
            { color: isUser ? "#050A0F" : colors.foreground },
          ]}
        >
          {message.content || (
            <Text style={{ color: colors.mutedForeground, fontStyle: "italic" }}>
              ...
            </Text>
          )}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginVertical: 4,
    paddingHorizontal: 16,
    alignItems: "flex-end",
    gap: 8,
  },
  rowUser: {
    justifyContent: "flex-end",
  },
  rowAssistant: {
    justifyContent: "flex-start",
  },
  avatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 2,
  },
  avatarText: {
    fontSize: 12,
    fontWeight: "700",
  },
  bubble: {
    maxWidth: "75%",
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    borderColor: "transparent",
  },
  userBubble: {
    borderBottomRightRadius: 4,
  },
  assistantBubble: {
    borderBottomLeftRadius: 4,
  },
  senderName: {
    fontSize: 10,
    fontWeight: "600",
    marginBottom: 3,
    letterSpacing: 0.5,
    textTransform: "uppercase",
  },
  text: {
    fontSize: 15,
    lineHeight: 22,
    fontFamily: Platform.OS === "ios" ? "Inter_400Regular" : undefined,
  },
});
