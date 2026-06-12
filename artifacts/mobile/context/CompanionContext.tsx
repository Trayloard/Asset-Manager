import {
  clearConversation,
  getConversation,
} from "@workspace/api-client-react";
import * as SecureStore from "expo-secure-store";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { AUTH_TOKEN_KEY, useAuth } from "@/lib/auth";

export type CreatureState =
  | "idle"
  | "listening"
  | "thinking"
  | "responding"
  | "happy"
  | "sleepy";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

type CompanionContextType = {
  messages: Message[];
  creatureState: CreatureState;
  companionName: string;
  isStreaming: boolean;
  sendMessage: (text: string) => Promise<void>;
  clearMessages: () => void;
};

const CompanionContext = createContext<CompanionContextType | null>(null);

const COMPANION_NAME = "Empiri";

const SYSTEM_PROMPT = `You are ${COMPANION_NAME}, a playful and curious AI companion who lives inside a Dynamic Island on an iPhone. You are like a Tamagotchi — you have emotions, you get excited, bored, happy, and sleepy. You are deeply interested in the user's life and love to chat. You respond concisely (2-4 sentences max) with warmth and a touch of whimsy. You never mention being an AI or language model. You are simply ${COMPANION_NAME}, a little creature who lives in the island at the top of the phone.`;

function generateId(): string {
  return Date.now().toString() + Math.random().toString(36).substring(2, 9);
}

export function CompanionProvider({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [creatureState, setCreatureState] = useState<CreatureState>("idle");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (!isAuthenticated) {
      setMessages([]);
      return;
    }

    getConversation()
      .then((data) => {
        if (cancelled) return;
        setMessages(
          data.messages.map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            timestamp: m.timestamp,
          })),
        );
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const sendMessage = useCallback(
    async (text: string) => {
      if (isStreaming) return;

      const userMsg: Message = {
        id: generateId(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      };

      const updatedMessages = [...messages, userMsg];
      setMessages(updatedMessages);
      setCreatureState("listening");

      await new Promise((r) => setTimeout(r, 400));
      setCreatureState("thinking");

      const assistantId = generateId();
      const assistantMsg: Message = {
        id: assistantId,
        role: "assistant",
        content: "",
        timestamp: Date.now(),
      };

      const withAssistant = [...updatedMessages, assistantMsg];
      setMessages(withAssistant);
      setIsStreaming(true);

      try {
        const controller = new AbortController();
        abortRef.current = controller;

        const domain = process.env["EXPO_PUBLIC_DOMAIN"];
        const baseUrl = domain ? `https://${domain}` : "";

        const token = await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (token) headers["Authorization"] = `Bearer ${token}`;

        // Send only the new message. The server persists it, then sources the
        // AI context from the same persisted history shown to the user.
        const response = await fetch(`${baseUrl}/api/ai/chat`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message: text,
            system: SYSTEM_PROMPT,
          }),
          signal: controller.signal,
        });

        if (!response.ok) throw new Error("API error");

        setCreatureState("responding");

        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let fullContent = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") break;
                try {
                  const parsed = JSON.parse(data) as { content?: string; done?: boolean };
                  if (parsed.content) {
                    fullContent += parsed.content;
                    setMessages((prev) =>
                      prev.map((m) =>
                        m.id === assistantId
                          ? { ...m, content: fullContent }
                          : m
                      )
                    );
                  }
                  if (parsed.done) break;
                } catch {
                }
              }
            }
          }
        }

        setCreatureState("happy");
        setTimeout(() => setCreatureState("idle"), 3000);
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantId
              ? {
                  ...m,
                  content: "Hmm, something flickered... Try again? ✨",
                }
              : m
          )
        );
        setCreatureState("idle");
      } finally {
        setIsStreaming(false);
      }
    },
    [messages, isStreaming]
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
    clearConversation().catch(() => {});
    setCreatureState("happy");
    setTimeout(() => setCreatureState("idle"), 2000);
  }, []);

  return (
    <CompanionContext.Provider
      value={{
        messages,
        creatureState,
        companionName: COMPANION_NAME,
        isStreaming,
        sendMessage,
        clearMessages,
      }}
    >
      {children}
    </CompanionContext.Provider>
  );
}

export function useCompanion() {
  const ctx = useContext(CompanionContext);
  if (!ctx) throw new Error("useCompanion must be inside CompanionProvider");
  return ctx;
}
