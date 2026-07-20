// Voice I/O for the Assistant.
//   - Input:  record the mic in the webview (getUserMedia + MediaRecorder),
//             then transcribe with OpenAI Whisper via tauri-plugin-http.
//   - Output: speak replies with the system voice (Web Speech Synthesis).
//
// This is purely an I/O layer around the existing askAssistant() flow — the
// transcript is fed in as a normal user turn, and the text reply is read out.

import { fetch } from "@tauri-apps/plugin-http";
import { getSettings } from "./settings";

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
export async function transcribe(blob: Blob): Promise<string> {
  const { openaiApiKey, sttModel } = getSettings();
  const key = openaiApiKey.trim();
  if (!key) throw new Error("No OpenAI API key set. Add one in Settings.");
  if (!blob.size) return "";

  const form = new FormData();
  form.append("file", blob, `audio.${extFor(blob.type)}`);
  form.append("model", sttModel || "whisper-1");

  // Note: don't set Content-Type — the multipart boundary is added automatically.
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });

  if (!res.ok) {
    let detail = "";
    try { const err = await res.json(); detail = err?.error?.message ?? JSON.stringify(err); }
    catch { detail = await res.text(); }
    throw new Error(`Transcription failed (${res.status}): ${detail}`);
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
  return md
    .replace(/```[\s\S]*?```/g, " code block ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_>#]/g, "")
    .replace(/\n{2,}/g, ". ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Speak text with the system voice, cancelling anything already playing. */
export function speak(text: string): void {
  if (!isSpeechSupported()) return;
  const synth = window.speechSynthesis;
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(stripMarkdown(text));
  synth.speak(utter);
}

export function stopSpeaking(): void {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}
