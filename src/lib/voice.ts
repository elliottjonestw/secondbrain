// Voice I/O for the Assistant.
//   - Input:  record the mic in the webview (getUserMedia + MediaRecorder),
//             then transcribe with OpenAI Whisper via tauri-plugin-http.
//   - Output: speak replies with the system voice (Web Speech Synthesis).
//
// This is purely an I/O layer around the existing askAssistant() flow — the
// transcript is fed in as a normal user turn, and the text reply is read out.

import { fetch } from "@tauri-apps/plugin-http";
import { getSettings } from "./settings";
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

/** Best installed voice for a language tag: exact match, then same base language. */
function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/_/g, "-");
  const want = norm(lang);
  const base = want.split("-")[0];
  const voices = window.speechSynthesis.getVoices();
  return voices.find((v) => norm(v.lang) === want)
    ?? voices.find((v) => norm(v.lang).startsWith(`${base}-`))
    ?? voices.find((v) => norm(v.lang) === base);
}

/** Whether the OS has a voice installed for a language. */
export async function hasVoiceFor(lang: string): Promise<boolean> {
  if (!isSpeechSupported()) return false;
  await ensureVoices();
  return !!pickVoice(lang);
}

/** Speak text with the system voice, cancelling anything already playing. */
export function speak(text: string): void {
  if (!isSpeechSupported()) return;
  const spoken = stripMarkdown(text);
  if (!spoken) return;

  const synth = window.speechSynthesis;
  synth.cancel();

  void ensureVoices().then(() => {
    const lang = speechLang(spoken);
    const utter = new SpeechSynthesisUtterance(spoken);
    // Without an explicit lang the utterance inherits <html lang>, so a Chinese
    // reply was being handed to an English voice — which reads nothing at all.
    utter.lang = lang;
    const voice = pickVoice(lang);
    if (voice) {
      utter.voice = voice;
    } else {
      // Nothing installed for this language: macOS ships most non-system
      // voices on demand, so this is the usual reason for silence.
      console.warn(`No installed speech voice for "${lang}" — reply not spoken.`);
    }
    synth.speak(utter);
  });
}

export function stopSpeaking(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}
