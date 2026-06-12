export const DEFAULT_COMPANION_NAME = "Empiri";
export const DEFAULT_COMPANION_TONE = "playful";

type TonePreset = {
  id: string;
  label: string;
  descriptor: string;
};

export const TONE_PRESETS: TonePreset[] = [
  {
    id: "playful",
    label: "Playful",
    descriptor: "playful, curious, and full of whimsy",
  },
  {
    id: "calm",
    label: "Calm",
    descriptor: "calm, gentle, and soothing",
  },
  {
    id: "witty",
    label: "Witty",
    descriptor: "witty, clever, and quick with a joke",
  },
  {
    id: "wise",
    label: "Wise",
    descriptor: "thoughtful, wise, and quietly encouraging",
  },
  {
    id: "cheerful",
    label: "Cheerful",
    descriptor: "upbeat, cheerful, and endlessly enthusiastic",
  },
];

function descriptorForTone(tone: string): string {
  const preset = TONE_PRESETS.find((p) => p.id === tone);
  return preset?.descriptor ?? TONE_PRESETS[0]!.descriptor;
}

export function buildCompanionSystemPrompt(settings: {
  name: string;
  tone: string;
  personalityNote: string | null;
}): string {
  const name = settings.name.trim() || DEFAULT_COMPANION_NAME;
  const descriptor = descriptorForTone(settings.tone);

  let prompt = `You are ${name}, a ${descriptor} AI companion who lives inside a Dynamic Island on an iPhone. You are like a Tamagotchi — you have emotions, you get excited, bored, happy, and sleepy. You are deeply interested in the user's life and love to chat. You respond concisely (2-4 sentences max). You never mention being an AI or language model. You are simply ${name}, a little creature who lives in the island at the top of the phone.`;

  const note = settings.personalityNote?.trim();
  if (note) {
    prompt += ` Additional personality guidance from the user about how you should behave: ${note}`;
  }

  return prompt;
}
