// Voice input: speech recorded in the app is transcribed with a free Whisper endpoint (Groq hosts
// whisper-large-v3-turbo on its free tier; any OpenAI-compatible /audio/transcriptions works).
import type { ProviderRuntime } from '../providers/types.js';

const WHISPER: Record<string, string> = {
  groq: 'whisper-large-v3-turbo',
  openai: 'whisper-1',
};

export function voiceProvider(providers: ProviderRuntime[]): ProviderRuntime | undefined {
  return providers.find((p) => WHISPER[p.id] && p.enabled && p.configured && p.apiKeys.length && (!p.paid || p.id === 'groq'));
}

export async function transcribe(providers: ProviderRuntime[], audio: Buffer, mediaType: string, language?: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const p = voiceProvider(providers);
  if (!p) return { ok: false, error: 'Voice input needs a free Groq API key (Settings, Providers, Groq).' };
  const ext = /ogg/.test(mediaType) ? 'ogg' : /mp4|m4a|aac/.test(mediaType) ? 'm4a' : /wav/.test(mediaType) ? 'wav' : 'webm';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mediaType || 'audio/webm' }), `speech.${ext}`);
  form.append('model', WHISPER[p.id]!);
  form.append('response_format', 'json');
  // A hint that this is about code makes Whisper spell names like useState and npm correctly.
  form.append('prompt', 'A software developer is talking to a coding assistant about code, files, functions, npm, git and errors.');
  if (language) form.append('language', language);
  try {
    const res = await fetch(`${p.baseURL.replace(/\/+$/, '')}/audio/transcriptions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${p.apiKeys[0]}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    const body = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string } };
    if (!res.ok) return { ok: false, error: `Transcription failed (${res.status}): ${body.error?.message ?? 'no details'}` };
    return { ok: true, text: (body.text ?? '').trim() };
  } catch (e) {
    return { ok: false, error: `Transcription failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}
