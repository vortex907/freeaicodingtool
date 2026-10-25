// Heuristic knowledge about model families, used to rank models that were discovered at runtime.
// Scores are rough "agentic coding ability" estimates on a 0-100 scale.

interface FamilyRule {
  re: RegExp;
  quality: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Typical context window when the provider does not report one. */
  context?: number;
  /** Tool calling is unreliable or unsupported natively. */
  textTools?: boolean;
  /** Takes an effort level (reasoning_effort, or Claude's output_config.effort). */
  effort?: boolean;
}

// Order matters: the first matching rule wins, so specific patterns come first.
const FAMILY_RULES: FamilyRule[] = [
  // Anthropic (Claude 5 models think by default and have a 1M context window; older ones are listed at 200K)
  { re: /claude.*fable/i, quality: 99, reasoning: true, context: 1000000, vision: true, effort: true },
  { re: /claude.*opus[-.]?[5-9]/i, quality: 98, reasoning: true, context: 1000000, vision: true, effort: true },
  { re: /claude.*sonnet[-.]?[5-9]/i, quality: 96, reasoning: true, context: 1000000, vision: true, effort: true },
  { re: /claude.*haiku[-.]?[5-9]/i, quality: 88, reasoning: true, context: 1000000, vision: true, effort: true },
  { re: /claude.*opus/i, quality: 94, context: 200000, vision: true },
  { re: /claude.*sonnet/i, quality: 92, context: 200000, vision: true },
  { re: /claude.*haiku/i, quality: 80, context: 200000, vision: true },
  { re: /claude/i, quality: 85, context: 200000 },
  // OpenAI
  { re: /gpt-oss[-:]120b/i, quality: 74, reasoning: true, context: 131072, effort: true },
  { re: /gpt-oss[-:]20b/i, quality: 58, reasoning: true, context: 131072, effort: true },
  { re: /gpt-5[.\d]*-?codex/i, quality: 93, reasoning: true, context: 400000, effort: true },
  { re: /gpt-5[.\d]*-nano/i, quality: 66, reasoning: true, context: 400000, effort: true },
  { re: /gpt-5[.\d]*-mini/i, quality: 84, reasoning: true, context: 400000, effort: true },
  { re: /gpt-5/i, quality: 93, reasoning: true, context: 400000, vision: true, effort: true },
  { re: /gpt-4\.1-nano/i, quality: 52, context: 1047576 },
  { re: /gpt-4\.1-mini/i, quality: 68, context: 1047576 },
  { re: /gpt-4\.1/i, quality: 76, context: 1047576, vision: true },
  { re: /gpt-4o-mini/i, quality: 55, context: 128000 },
  { re: /gpt-4o/i, quality: 68, context: 128000, vision: true },
  { re: /\bo[34](-mini)?\b/i, quality: 78, reasoning: true, context: 200000, effort: true },
  // Google
  { re: /gemini-?[3-9][.\d]*-?pro/i, quality: 93, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-?[3-9][.\d]*-?flash-?lite/i, quality: 72, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-?[3-9][.\d]*-?flash/i, quality: 85, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-pro-latest/i, quality: 92, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-flash-lite-latest/i, quality: 72, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-flash-latest/i, quality: 84, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-2\.5-pro/i, quality: 86, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-2\.5-flash-lite/i, quality: 60, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-2\.5-flash/i, quality: 74, reasoning: true, context: 1048576, vision: true },
  { re: /gemini-2\.0-flash-lite/i, quality: 50, context: 1048576 },
  { re: /gemini-2\.0-flash/i, quality: 60, context: 1048576 },
  { re: /gemini/i, quality: 60, context: 1048576 },
  { re: /gemma-?[4-9]/i, quality: 62, context: 131072 },
  { re: /gemma-?3n/i, quality: 35, context: 32768, textTools: true },
  { re: /gemma-?3/i, quality: 45, context: 131072, textTools: true },
  { re: /gemma/i, quality: 35, context: 8192, textTools: true },
  // Moonshot
  { re: /kimi-?k[2-9][.\d]*.*thinking/i, quality: 88, reasoning: true, context: 262144 },
  { re: /kimi-?k[2-9]/i, quality: 87, context: 262144 },
  { re: /kimi/i, quality: 75, context: 131072 },
  // Zhipu / Z.ai
  { re: /glm-?[5-9][.\d]*-?flash/i, quality: 76, reasoning: true, context: 200000 },
  { re: /glm-?[5-9][.\d]*-?air/i, quality: 82, reasoning: true, context: 200000 },
  { re: /glm-?[5-9]/i, quality: 90, reasoning: true, context: 200000 },
  { re: /glm-?4\.[6-9]-?flash/i, quality: 70, reasoning: true, context: 200000 },
  { re: /glm-?4\.[5-9]-?flash/i, quality: 60, reasoning: true, context: 131072 },
  { re: /glm-?4\.[5-9]-?air/i, quality: 74, reasoning: true, context: 131072 },
  { re: /glm-?4\.[6-9]/i, quality: 85, reasoning: true, context: 200000 },
  { re: /glm-?4\.5/i, quality: 80, reasoning: true, context: 131072 },
  { re: /glm-?z1/i, quality: 40, reasoning: true, context: 32768, textTools: true },
  { re: /glm-?4/i, quality: 42, context: 32768 },
  // DeepSeek
  { re: /deepseek.*v[4-9].*flash/i, quality: 82, context: 131072 },
  { re: /deepseek.*v[4-9]/i, quality: 91, context: 131072 },
  { re: /deepseek.*v3\.[2-9]/i, quality: 86, context: 131072 },
  { re: /deepseek.*v3\.1/i, quality: 83, context: 131072 },
  { re: /deepseek.*(chat|v3)/i, quality: 80, context: 131072 },
  { re: /deepseek.*r1.*(distill|qwen|llama|8b|7b|14b|32b|70b)/i, quality: 42, reasoning: true, context: 65536, textTools: true },
  { re: /deepseek.*(r1|reasoner)/i, quality: 72, reasoning: true, context: 131072 },
  { re: /deepseek.*coder/i, quality: 50, context: 65536 },
  { re: /deepseek/i, quality: 70, context: 65536 },
  // Qwen
  { re: /qwen[\d.]*-?coder-?plus/i, quality: 87, context: 1000000 },
  { re: /qwen[\d.]*-?coder-?flash/i, quality: 74, context: 1000000 },
  { re: /qwen3[.\d]*-?coder.*480b/i, quality: 85, context: 262144 },
  { re: /qwen3[.\d]*-?coder.*30b/i, quality: 66, context: 262144 },
  { re: /qwen3[.\d]*-?coder/i, quality: 82, context: 262144 },
  { re: /qwen[\d.]*-?max/i, quality: 87, context: 262144 },
  { re: /qwen3[.\d]*-?235b/i, quality: 77, reasoning: true, context: 131072 },
  { re: /qwen3\.[5-9].*(397b|480b|max)/i, quality: 88, reasoning: true, context: 262144 },
  { re: /qwen3\.[5-9].*(122b|235b)/i, quality: 82, reasoning: true, context: 262144 },
  { re: /qwen3\.[5-9]/i, quality: 74, reasoning: true, context: 262144 },
  { re: /qwen3[.\d]*-?(30b|32b)/i, quality: 60, reasoning: true, context: 131072 },
  { re: /qwen3[.\d]*-?(14b|8b|4b|1\.7b|0\.6b)/i, quality: 42, reasoning: true, context: 32768 },
  { re: /qwen[\d.]*-?plus/i, quality: 72, context: 131072 },
  { re: /qwen[\d.]*-?flash|qwen-turbo/i, quality: 60, context: 1000000 },
  { re: /qwen2\.5-?coder-?32b/i, quality: 52, context: 32768 },
  { re: /qwen2\.5-?72b/i, quality: 52, context: 32768 },
  { re: /qwq/i, quality: 55, reasoning: true, context: 32768, textTools: true },
  { re: /qwen/i, quality: 45, context: 32768 },
  // MiniMax / Xiaomi / others
  { re: /minimax-?m[2-9][.\d]*-?(flash|lightning|mini)/i, quality: 74, reasoning: true, context: 196608 },
  { re: /minimax-?m[2-9]/i, quality: 84, reasoning: true, context: 196608 },
  { re: /minimax/i, quality: 70, context: 196608 },
  { re: /mimo-?v?[2-9]/i, quality: 78, reasoning: true, context: 131072 },
  { re: /mimo/i, quality: 60, reasoning: true, context: 32768 },
  { re: /longcat/i, quality: 74, context: 131072 },
  { re: /laguna/i, quality: 72, context: 131072 },
  { re: /inkling/i, quality: 62, context: 131072 },
  { re: /kat-?coder/i, quality: 78, context: 262144 },
  { re: /big-pickle/i, quality: 76, context: 200000 },
  { re: /hunyuan/i, quality: 60, context: 131072 },
  { re: /ernie/i, quality: 60, context: 131072 },
  { re: /seed-?oss|doubao/i, quality: 72, context: 131072 },
  // NVIDIA
  { re: /nemotron.*ultra/i, quality: 79, reasoning: true, context: 131072 },
  { re: /nemotron.*super/i, quality: 71, reasoning: true, context: 131072 },
  { re: /nemotron.*nano/i, quality: 48, reasoning: true, context: 131072 },
  { re: /nemotron/i, quality: 55, context: 131072 },
  // Mistral
  { re: /devstral-?2(?!.*small)|devstral-(medium|latest)/i, quality: 81, context: 262144 },
  { re: /devstral.*small/i, quality: 66, context: 131072 },
  { re: /devstral/i, quality: 70, context: 131072 },
  { re: /magistral-?medium/i, quality: 72, reasoning: true, context: 131072 },
  { re: /magistral/i, quality: 58, reasoning: true, context: 131072 },
  { re: /mistral-?large/i, quality: 78, context: 131072 },
  { re: /mistral-?medium/i, quality: 75, context: 131072 },
  { re: /codestral/i, quality: 62, context: 262144 },
  { re: /mistral-?small/i, quality: 55, context: 131072 },
  { re: /ministral/i, quality: 42, context: 131072 },
  { re: /pixtral-?large/i, quality: 62, context: 131072, vision: true },
  { re: /mixtral/i, quality: 40, context: 32768 },
  { re: /mistral/i, quality: 45, context: 32768 },
  // Cohere
  { re: /north.*code/i, quality: 66, context: 256000 },
  { re: /command-?a.*reason/i, quality: 66, reasoning: true, context: 256000 },
  { re: /command-?a/i, quality: 62, context: 256000 },
  { re: /command-?r7b/i, quality: 30, context: 128000 },
  { re: /command-?r/i, quality: 44, context: 128000 },
  // xAI
  { re: /grok-?code/i, quality: 81, reasoning: true, context: 256000 },
  { re: /grok-?[4-9].*fast/i, quality: 82, reasoning: true, context: 2000000 },
  { re: /grok-?[4-9]/i, quality: 90, reasoning: true, context: 256000 },
  { re: /grok-?3-?mini/i, quality: 66, reasoning: true, context: 131072 },
  { re: /grok/i, quality: 72, context: 131072 },
  // Meta
  { re: /llama-?4.*maverick/i, quality: 60, context: 1048576, vision: true },
  { re: /llama-?4.*scout/i, quality: 52, context: 131072, vision: true },
  { re: /llama-?3\.1-?405b/i, quality: 60, context: 131072 },
  { re: /llama-?3\.[0-9]-?70b|llama-?3-?70b|llama.*70b/i, quality: 56, context: 131072 },
  { re: /llama.*(8b|3b|1b|11b)/i, quality: 30, context: 131072 },
  { re: /llama/i, quality: 45, context: 131072 },
  // Small/legacy families
  { re: /phi-?4/i, quality: 40, context: 16384 },
  { re: /phi/i, quality: 28, context: 4096, textTools: true },
  { re: /granite/i, quality: 40, context: 131072 },
  { re: /hermes/i, quality: 50, context: 131072 },
  { re: /jamba/i, quality: 45, context: 256000 },
  { re: /olmo/i, quality: 40, context: 65536 },
  { re: /starcoder|codegemma|codellama/i, quality: 25, context: 16384, textTools: true },
];

const NON_CHAT = /embed|embedding|rerank|retriev|whisper|tts|speech|audio|transcri|voxtral|moderation|guard|safety|reward|classif|ocr|parse|clip|imagen|image-gen|imagegen|dall-?e|flux|sdxl|stable-diffusion|veo|sora|text-to-image|vision-only|aqa|bge-|e5-|arctic-embed|nemoretriever|riva|translate|grounding|yolo|detector|segment|depth|cosmos|kosmos|deplot|paligemma|fuyu|neva|vila|nv-embed|-tts|playai|orpheus|lyria|realtime|computer-use|nano-banana|robotics|live-|(?:^|[-_/.])image(?:[-_.]|$)/i;

export function isChatModelId(id: string): boolean {
  return !NON_CHAT.test(id);
}

export interface ModelEstimate {
  quality: number;
  reasoning: boolean;
  vision: boolean;
  context: number;
  textTools: boolean;
  effort: boolean;
}

/** Estimates model characteristics from its id. */
export function estimateModel(id: string): ModelEstimate {
  const lower = id.toLowerCase();
  for (const r of FAMILY_RULES) {
    if (r.re.test(lower)) {
      let q = r.quality;
      if (/(^|[-_/:])(free)$/.test(lower) || lower.endsWith(':free')) q -= 1; // free endpoints are often quantized/queued
      if (/-?(int4|awq|gptq|q4|fp4|nvfp4)/.test(lower)) q -= 3;
      return {
        quality: clamp(q),
        reasoning: !!r.reasoning || /thinking|reason|-r1|\br1\b/.test(lower),
        vision: !!r.vision || /vision|-vl\b|-vl-|omni/.test(lower),
        context: r.context ?? 32768,
        textTools: !!r.textTools,
        effort: !!r.effort,
      };
    }
  }
  // Unknown family: estimate from parameter count in the name.
  const params = parseParamCount(lower);
  let q = 45;
  if (params !== null) {
    if (params >= 400) q = 74;
    else if (params >= 200) q = 70;
    else if (params >= 100) q = 64;
    else if (params >= 60) q = 55;
    else if (params >= 30) q = 50;
    else if (params >= 14) q = 42;
    else if (params >= 7) q = 32;
    else q = 22;
  }
  if (/coder|code/.test(lower)) q += 4;
  if (/mini|nano|lite|tiny|small/.test(lower)) q -= 6;
  return {
    quality: clamp(q),
    reasoning: /thinking|reason|-r1|\br1\b/.test(lower),
    vision: /vision|-vl\b|-vl-|omni/.test(lower),
    context: 32768,
    textTools: params !== null && params < 7,
    effort: false,
  };
}

/** Parses "480b", "70B", "8x7b", "a22b" style parameter counts (billions). */
export function parseParamCount(id: string): number | null {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b\b/i.exec(id);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const all = [...id.matchAll(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z])/gi)].map((m) => Number(m[1]));
  if (!all.length) return null;
  return Math.max(...all);
}

function clamp(n: number): number {
  return Math.max(1, Math.min(100, Math.round(n)));
}

/** Short tier label for UI. */
export function qualityTier(q: number): string {
  if (q >= 88) return 'S';
  if (q >= 78) return 'A';
  if (q >= 65) return 'B';
  if (q >= 50) return 'C';
  return 'D';
}
