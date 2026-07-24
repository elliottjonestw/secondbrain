// OpenAI text-to-speech — the "natural voice" engine for spoken replies.
//
// Why this and not the OS: macOS system voices top out at Enhanced/Premium,
// which still sound synthetic next to a neural voice, and the gap is widest in
// Chinese. This uses the OpenAI key that's already configured for the assistant
// and voice input, so it adds no new account, and api.openai.com is already in
// the http scope.
//
// Not free — billed per character, on the order of a cent per minute of audio —
// which is why the engine is a setting and system voices remain the default
// path when it's unavailable. Microsoft's free Edge "Read Aloud" endpoint was
// evaluated first and rejected: its synthesis path now returns 403 to every
// request (the voices-list endpoint still works, the trusted token is still
// valid, and the clock is in sync, so this is deliberate hardening rather than
// something to work around). Don't reach for it again without re-testing.

import { httpFetch as fetch } from "./httpFetch";
import i18next from "i18next";
import { getSettings, clampSpeechRate } from "./settings";
import { getOpenAiKey } from "./secrets";

const ENDPOINT = "https://api.openai.com/v1/audio/speech";

/** A voice offered in Settings. OpenAI's voices are multilingual, not per-locale. */
export interface OpenAiVoice {
  id: string;
  /** Display name. Not translated — these are proper nouns. */
  name: string;
}

export const OPENAI_VOICES: OpenAiVoice[] = [
  { id: "alloy", name: "Alloy" },
  { id: "ash", name: "Ash" },
  { id: "ballad", name: "Ballad" },
  { id: "coral", name: "Coral" },
  { id: "echo", name: "Echo" },
  { id: "fable", name: "Fable" },
  { id: "nova", name: "Nova" },
  { id: "onyx", name: "Onyx" },
  { id: "sage", name: "Sage" },
  { id: "shimmer", name: "Shimmer" },
  { id: "verse", name: "Verse" },
];

export const DEFAULT_OPENAI_VOICE = "coral";

/**
 * Accent/tone steering, sent as the model's `instructions`.
 *
 * This is the reason zh-TW sounds right rather than merely intelligible: the
 * voices are multilingual but default to mainland-flavoured Mandarin, and this
 * is the only lever that asks for Taiwanese Mandarin specifically. Model-facing
 * text, so it stays English like SYSTEM_PROMPT and the tool descriptions.
 */
const VOICE_INSTRUCTIONS: Record<string, string> = {
  "zh-TW": "Speak in natural Taiwanese Mandarin as heard in Taipei, using Taiwan " +
    "vocabulary and intonation rather than mainland Putonghua. Warm, calm and " +
    "conversational.",
  en: "Speak in a warm, calm, conversational tone.",
};

/**
 * Pace, described in words — sent *alongside* `speed`, not instead of it.
 *
 * Measured on gpt-4o-mini-tts with identical text (durations in seconds):
 * speed 1.0 alone 6.55; instruction alone at speed 1.0 6.86 (i.e. the wording
 * barely moves it); speed 1.6 alone 4.44; speed 1.6 + wording 3.79. So `speed`
 * is what actually works, and the clause is a modest reinforcement — worth
 * keeping because it nudges *delivery* (energy, phrasing) rather than just
 * playback rate, but don't mistake it for the mechanism.
 *
 * (Widely-repeated reports that gpt-4o-mini-tts ignores `speed` were true at
 * some point but are not true as of the measurements above. tts-1 is the
 * reverse case: it honours `speed` and rejects `instructions` outright.)
 */
function paceClause(rate: number): string {
  if (rate <= 0.7) return " Speak much more slowly than normal — unhurried and deliberate.";
  if (rate < 0.9) return " Speak a little more slowly than normal.";
  if (rate <= 1.1) return " Speak at a relaxed, natural pace.";
  if (rate < 1.5) return " Speak a little faster than normal, with brisk energy.";
  return " Speak much faster than normal — quick and energetic, but still clear.";
}

/**
 * `instructions` only exists on the gpt-4o TTS models — the older tts-1 family
 * rejects the field, so someone who sets `ttsModel` to `tts-1` would get a 400
 * on every reply and silently drop back to the system voice.
 */
function instructionsFor(lang: string, model: string, rate: number): string | undefined {
  if (!model.startsWith("gpt-4o")) return undefined;
  const tone = VOICE_INSTRUCTIONS[lang] ?? VOICE_INSTRUCTIONS[lang.split("-")[0]];
  return tone ? tone + paceClause(rate) : paceClause(rate).trim();
}

/** Synthesise `text` and resolve the MP3 audio. Throws so callers can fall back. */
export async function synthesize(
  text: string,
  voice: string,
  lang: string,
  /** Speaking rate; defaults to the saved setting. Passed explicitly by the
   *  Settings preview so the slider can be heard before it's saved. */
  rate?: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const { ttsModel, speechRate } = getSettings();
  const key = getOpenAiKey();
  if (!key) throw new Error(i18next.t("errors.noApiKey"));
  const model = ttsModel || "gpt-4o-mini-tts";
  const speed = clampSpeechRate(rate ?? speechRate);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      voice,
      input: text,
      instructions: instructionsFor(lang, model, speed),
      speed,
      response_format: "mp3",
    }),
    signal,
  });

  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(`OpenAI TTS ${res.status}: ${detail}`);
  }

  return new Blob([await res.arrayBuffer()], { type: "audio/mpeg" });
}
