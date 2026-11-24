import React from "react";

export type CreatureState =
  | "idle"
  | "listening"
  | "thinking"
  | "responding"
  | "happy"
  | "sleepy"
  | "sad";

export type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
};

export { CompanionProvider, useCompanion } from "@/contexts/CompanionContext";
