import { VOICE_STYLES } from "./voices";
import type { WorldSpec } from "@bimpee/shared";

/** Optional text-to-speech via the Web Speech API. Off by default. */
export function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

export function speak(text: string, voice: WorldSpec["narrator"]["voice"]): void {
  if (!ttsSupported() || !text.trim()) return;
  try {
    const s = VOICE_STYLES[voice];
    const u = new SpeechSynthesisUtterance(text);
    u.rate = s.rate;
    u.pitch = s.pitch;
    u.volume = 0.9;
    const en = window.speechSynthesis.getVoices().find((v) => v.lang.startsWith("en"));
    if (en) u.voice = en;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch {
    /* speech is best-effort */
  }
}

export function cancelSpeech(): void {
  if (!ttsSupported()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}
