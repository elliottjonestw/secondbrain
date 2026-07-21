// Voice I/O for the Assistant.
//   - Input:  record the mic in the webview (getUserMedia + MediaRecorder),
//             then transcribe with OpenAI Whisper via tauri-plugin-http.
//   - Output: speak replies with a system voice (Web Speech Synthesis), picking
//             the best-quality one installed unless the user chose another.
//
// This is purely an I/O layer around the existing askAssistant() flow — the
// transcript is fed in as a normal user turn, and the text reply is read out.

import { fetch } from "@tauri-apps/plugin-http";
import { getSettings, clampSpeechRate } from "./settings";
import { synthesize, DEFAULT_OPENAI_VOICE } from "./openaiTts";
import i18next from "i18next";
import { currentLanguage } from "./i18n";

/** Han, Hiragana/Katakana, and Hangul — text that needs a CJK voice. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯]/;

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
export interface Recording {
  /** Stop and resolve the recorded audio blob. */
  stop(): Promise<Blob>;
  /** Abort without producing a blob (releases the mic). */
  cancel(): void;
}

/** Pick a container/codec MediaRecorder supports (WKWebView tends to prefer mp4). */
function preferredMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const c of ["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav"]) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return undefined;
}

/** Begin recording from the default microphone. Throws if permission denied. */
export async function startRecording(): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeType = preferredMime();
  const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start();

  const release = () => stream.getTracks().forEach((t) => t.stop());

  return {
    stop: () =>
      new Promise<Blob>((resolve) => {
        rec.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: rec.mimeType || mimeType || "audio/webm" }));
        };
        rec.stop();
      }),
    cancel: () => {
      try { rec.stop(); } catch { /* ignore */ }
      release();
    },
  };
}

export function isRecordingSupported(): boolean {
  return typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined";
}

// ---------------------------------------------------------------------------
// Transcription (OpenAI Whisper)
// ---------------------------------------------------------------------------
function extFor(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  return "webm";
}

/** Transcribe recorded audio to text. Returns "" if nothing was heard. */
export async function transcribe(blob: Blob, signal?: AbortSignal): Promise<string> {
  const { openaiApiKey, sttModel } = getSettings();
  const key = openaiApiKey.trim();
  if (!key) throw new Error(i18next.t("errors.noApiKey"));
  if (!blob.size) return "";

  const form = new FormData();
  form.append("file", blob, `audio.${extFor(blob.type)}`);
  form.append("model", sttModel || "whisper-1");

  // Deliberately not sending `language`: that would *force* a language and
  // break bilingual speech ("提醒我 3pm 開會"), which is exactly how someone
  // running the app in Chinese tends to talk. A `prompt` only biases the
  // decoder, which is enough to stop Whisper emitting Simplified characters
  // for a Traditional speaker while leaving auto-detection intact.
  if (currentLanguage() === "zh-TW") {
    form.append("prompt", "以下是繁體中文的內容。");
  }

  // Note: don't set Content-Type — the multipart boundary is added automatically.
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
    signal,
  });

  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(i18next.t("errors.transcription", { status: res.status, detail }));
  }
  const data = await res.json();
  return (data?.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Speech output (system voices)
// ---------------------------------------------------------------------------
export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Reduce markdown to plain text so the TTS engine doesn't read symbols aloud. */
function stripMarkdown(md: string): string {
  // CJK sentences end with a full-width stop; joining paragraphs with an ASCII
  // ". " makes Chinese engines read an odd pause (or the word "dot").
  const sentenceJoin = CJK_RE.test(md) ? "。" : ". ";
  return md
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    // The prompt tells the model not to use lists, precisely because they read
    // badly aloud. This is the fallback for when one slips through: drop the
    // marker so it speaks as a sentence instead of "dash" / "one dot".
    .replace(/^\s*[-+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_>#]/g, "")
    .replace(/\n{2,}/g, sentenceJoin)
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Which BCP 47 tag to speak a reply in.
 *
 * The assistant mirrors whatever language the user wrote in rather than
 * following the UI setting, so the reply itself is the only reliable signal —
 * hence sniffing the script. The UI language just decides which Chinese
 * variant to ask for.
 */
function speechLang(text: string): string {
  // zh-TW is the only Chinese variant we ship; widen this if that changes.
  if (CJK_RE.test(text)) return "zh-TW";
  return currentLanguage();
}

/**
 * WebKit populates the voice list asynchronously and returns [] on the first
 * call, so a reply spoken right after launch would get no voice at all. Wait
 * for `voiceschanged` once, with a timeout so we never hang.
 */
let voicesReady: Promise<void> | null = null;
function ensureVoices(): Promise<void> {
  if (!isSpeechSupported()) return Promise.resolve();
  const synth = window.speechSynthesis;
  if (synth.getVoices().length > 0) return Promise.resolve();
  if (!voicesReady) {
    voicesReady = new Promise<void>((resolve) => {
      const done = () => { synth.removeEventListener("voiceschanged", done); resolve(); };
      synth.addEventListener("voiceschanged", done);
      setTimeout(done, 2000);
    });
  }
  return voicesReady;
}

const norm = (s: string) => s.toLowerCase().replace(/_/g, "-");

/**
 * macOS exposes joke voices ("Bad News", "Zarvox") through the same API as real
 * ones, and they match `en` like any other — so without a blocklist the first
 * English match can be a singing robot. Matched on the name with the quality
 * suffix stripped.
 */
const NOVELTY_VOICES = new Set([
  "albert", "bad news", "bahh", "bells", "boing", "bubbles", "cellos",
  "deranged", "good news", "jester", "organ", "superstar", "trinoids",
  "whisper", "wobble", "zarvox", "fred", "junior", "hysterical", "pipe organ",
]);

export type VoiceQuality = "premium" | "enhanced" | "standard" | "compact";

/**
 * Which tier a voice belongs to.
 *
 * This is the crux of the "system voices sound robotic" problem: macOS ships a
 * *compact* voice for every language and downloads the good ones on demand, so
 * the naive "first voice matching the language" pick sounds synthetic even when
 * a far better voice is installed alongside it. The tier is only exposed as a
 * parenthesised suffix on the name ("Ava (Premium)"), so that's what we read.
 */
function qualityOf(voice: SpeechSynthesisVoice): VoiceQuality {
  const n = voice.name.toLowerCase();
  if (n.includes("premium") || n.includes("neural")) return "premium";
  if (n.includes("enhanced")) return "enhanced";
  if (n.includes("compact")) return "compact";
  return "standard";
}

const QUALITY_RANK: Record<VoiceQuality, number> = {
  premium: 3, enhanced: 2, standard: 1, compact: 0,
};

/** Name without the quality suffix: "Ava (Premium)" → "ava". */
function baseName(voice: SpeechSynthesisVoice): string {
  return voice.name.replace(/\s*\([^)]*\)\s*$/, "").trim().toLowerCase();
}

/** 2 = exact tag, 1 = same base language, 0 = unusable for this language. */
function langScore(voice: SpeechSynthesisVoice, want: string): number {
  const have = norm(voice.lang);
  const base = want.split("-")[0];
  if (have === want) return 2;
  if (have === base || have.startsWith(`${base}-`)) return 1;
  return 0;
}

/** A user-selectable voice. */
export interface VoiceOption {
  uri: string;
  name: string;
  lang: string;
  quality: VoiceQuality;
}

/** Usable voices for a language, best first. Novelty voices are excluded. */
function candidates(lang: string): SpeechSynthesisVoice[] {
  const want = norm(lang);
  return window.speechSynthesis.getVoices()
    .filter((v) => langScore(v, want) > 0 && !NOVELTY_VOICES.has(baseName(v)))
    .sort((a, b) =>
      langScore(b, want) - langScore(a, want) ||
      QUALITY_RANK[qualityOf(b)] - QUALITY_RANK[qualityOf(a)] ||
      a.name.localeCompare(b.name));
}

/** Voices the user can choose from for a language, best first. */
export async function listVoices(lang: string): Promise<VoiceOption[]> {
  if (!isSpeechSupported()) return [];
  await ensureVoices();
  return candidates(lang).map((v) => ({
    uri: v.voiceURI, name: v.name, lang: v.lang, quality: qualityOf(v),
  }));
}

/**
 * Voice to speak a language with: the user's saved choice if it's still
 * installed, otherwise the highest-quality installed match.
 */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const options = candidates(lang);
  const saved = getSettings().preferredVoices?.[lang];
  const chosen = saved ? options.find((v) => v.voiceURI === saved) : undefined;
  return chosen ?? options[0];
}

/** Whether the OS has a usable voice installed for a language. */
export async function hasVoiceFor(lang: string): Promise<boolean> {
  if (!isSpeechSupported()) return false;
  await ensureVoices();
  return !!pickVoice(lang);
}

/**
 * Sample sentences for the voice picker's preview button.
 *
 * Deliberately NOT run through t(): this text is spoken *by the voice being
 * previewed*, so it has to be in that voice's language regardless of the UI
 * language — previewing a Chinese voice from an English UI must still speak
 * Chinese, or the preview proves nothing.
 */
const VOICE_SAMPLES: Record<string, string> = {
  en: "Your next meeting starts at three this afternoon.",
  zh: "你今天下午三點有一場會議。",
};

/** Speak a short sample with a specific system voice, so a choice can be heard. */
export function previewVoice(lang: string, uri: string, rate?: number): void {
  if (!isSpeechSupported()) return;
  stopSpeaking();
  const id = ++speechId;
  void ensureVoices().then(() => {
    if (id !== speechId) return;
    const voice = candidates(lang).find((v) => v.voiceURI === uri);
    const utter = new SpeechSynthesisUtterance(
      VOICE_SAMPLES[lang.split("-")[0]] ?? VOICE_SAMPLES.en,
    );
    utter.lang = lang;
    utter.rate = clampSpeechRate(rate ?? getSettings().speechRate);
    if (voice) utter.voice = voice;
    window.speechSynthesis.speak(utter);
  });
}

// ---------------------------------------------------------------------------
// Playback
//
// Two engines, one lifecycle. Every utterance takes a ticket from `speechId`;
// anything that finishes holding a stale ticket is discarded. That's what stops
// a slow Edge request from talking over a newer reply, or its failure from
// falling back onto a reply the user has already moved past.
// ---------------------------------------------------------------------------
let speechId = 0;
let currentAudio: HTMLAudioElement | null = null;
let currentFetch: AbortController | null = null;

/** Tear down whatever is playing or being fetched, without bumping the ticket. */
function haltPlayback(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
  currentFetch?.abort();
  currentFetch = null;
  if (currentAudio) {
    currentAudio.pause();
    URL.revokeObjectURL(currentAudio.src);
    currentAudio = null;
  }
}

/**
 * Callbacks for one utterance.
 *
 * `onStart` fires when audio actually begins. The Assistant holds the reply
 * text back until then, so these carry a hard guarantee: **onStart always
 * happens before onEnd, and both always happen** — including when there's no
 * voice, no network, or an outright failure. Otherwise a speech problem would
 * silently swallow a perfectly good reply.
 */
export interface SpeakCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
}

/** Fire-once wrappers enforcing the start-before-end guarantee above. */
function guard(id: number, cb?: SpeakCallbacks) {
  let started = false;
  let ended = false;
  const start = () => {
    if (started || id !== speechId) return;
    started = true;
    cb?.onStart?.();
  };
  return {
    start,
    end: () => {
      if (ended || id !== speechId) return;
      start();
      ended = true;
      cb?.onEnd?.();
    },
  };
}

/** Speak with an OS voice. */
function speakWithSystem(text: string, lang: string, id: number, cb?: SpeakCallbacks): void {
  const g = guard(id, cb);
  void ensureVoices().then(() => {
    if (id !== speechId) return;
    const utter = new SpeechSynthesisUtterance(text);
    // Without an explicit lang the utterance inherits <html lang>, so a Chinese
    // reply was being handed to an English voice — which reads nothing at all.
    utter.lang = lang;
    utter.rate = clampSpeechRate(getSettings().speechRate);
    const voice = pickVoice(lang);
    if (voice) {
      utter.voice = voice;
    } else {
      // Nothing installed for this language: macOS ships most non-system
      // voices on demand, so this is the usual reason for silence. Nothing will
      // be spoken, so release the reply immediately rather than making the
      // caller wait on an utterance that produces no audio.
      console.warn(`No installed speech voice for "${lang}" — reply not spoken.`);
      g.end();
      return;
    }
    utter.onstart = g.start;
    utter.onend = g.end;
    utter.onerror = g.end;
    window.speechSynthesis.speak(utter);
  });
}

/** Speak with an OpenAI neural voice. Rejects so the caller can fall back. */
async function speakWithOpenai(
  text: string, lang: string, id: number, cb?: SpeakCallbacks,
): Promise<void> {
  const { openaiVoice, speechRate } = getSettings();
  const voice = openaiVoice || DEFAULT_OPENAI_VOICE;
  const controller = new AbortController();
  currentFetch = controller;
  const blob = await synthesize(text, voice, lang, speechRate, controller.signal);
  if (id !== speechId) return;

  const audio = new Audio(URL.createObjectURL(blob));
  currentAudio = audio;
  const g = guard(id, cb);
  const finish = () => {
    if (currentAudio === audio) {
      URL.revokeObjectURL(audio.src);
      currentAudio = null;
    }
    g.end();
  };
  // `onplay` rather than the play() promise: it's the moment sound actually
  // starts, which is what the reply text is waiting for.
  audio.onplay = g.start;
  audio.onended = finish;
  audio.onerror = finish;
  try {
    await audio.play();
  } catch (err) {
    // A NotAllowedError (or any play() failure) means no audio will ever come,
    // so finish() won't run. Revoke the blob URL and drop our hold on the
    // element here, then rethrow so speak() can fall back to a system voice —
    // without this the orphaned element could fire onerror later and run the
    // callbacks a second time over the fallback's own guard (same id).
    if (currentAudio === audio) {
      URL.revokeObjectURL(audio.src);
      currentAudio = null;
    }
    throw err;
  }
}

/**
 * Speak a reply, cancelling anything already playing. The callbacks don't fire
 * once this utterance is superseded or stopped, because whoever stopped it
 * already knows — see `SpeakCallbacks` for the ordering guarantee.
 */
export function speak(text: string, cb?: SpeakCallbacks): void {
  const spoken = stripMarkdown(text);
  // Cancel the prior utterance even when this one is empty — the function's
  // contract is "speak this, cancelling anything already playing", and an
  // empty/all-markdown reply shouldn't leave the last audio running.
  haltPlayback();
  if (!spoken) { cb?.onStart?.(); cb?.onEnd?.(); return; }

  const id = ++speechId;
  const lang = speechLang(spoken);

  if (getSettings().ttsEngine === "openai") {
    void speakWithOpenai(spoken, lang, id, cb).catch((err) => {
      if (id !== speechId) return;
      // Offline, no key, rate-limited, or a bad request. The reply still gets
      // spoken — that's the whole point of keeping system voices.
      console.warn("OpenAI TTS failed, falling back to a system voice:", err);
      lastNaturalError = err instanceof Error ? err.message : String(err);
      speakWithSystem(spoken, lang, id, cb);
    });
    return;
  }
  speakWithSystem(spoken, lang, id, cb);
}

export function stopSpeaking(): void {
  speechId++;
  haltPlayback();
}

/**
 * Why the last natural-voice attempt fell back, for Settings to surface.
 * Without this the degradation is completely invisible — the reply still
 * speaks, just in the old robotic voice, and the user can't tell that happened.
 */
let lastNaturalError: string | null = null;
export function getLastNaturalError(): string | null {
  return lastNaturalError;
}

/** Speak a sample with a specific OpenAI voice, so a choice can be heard. */
export async function previewNaturalVoice(
  lang: string, voice: string, rate?: number,
): Promise<void> {
  stopSpeaking();
  const id = ++speechId;
  const text = VOICE_SAMPLES[lang.split("-")[0]] ?? VOICE_SAMPLES.en;
  const controller = new AbortController();
  currentFetch = controller;
  const blob = await synthesize(text, voice, lang, rate, controller.signal);
  if (id !== speechId) return;
  const audio = new Audio(URL.createObjectURL(blob));
  currentAudio = audio;
  audio.onended = () => {
    if (currentAudio === audio) { URL.revokeObjectURL(audio.src); currentAudio = null; }
  };
  try {
    await audio.play();
  } catch (err) {
    // Same cleanup rationale as speakWithOpenai: finish() never runs on a
    // play() rejection, so revoke here before letting the caller see the error.
    if (currentAudio === audio) {
      URL.revokeObjectURL(audio.src);
      currentAudio = null;
    }
    throw err;
  }
}
