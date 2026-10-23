// Core provider/model/message types shared by the client, router and agent.
import type { RateLimits, ToolMode } from '../config/config.js';

export type { RateLimits, ToolMode };

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string;
  /** Provider data to send back with this call, e.g. Gemini's `extra_content.google.thought_signature`. */
  extra?: Record<string, unknown>;
}

/** How hard a reasoning model thinks, for models that take an effort level. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

/** US dollars per million tokens. */
export interface ModelPrice {
  input: number;
  output: number;
  /** Input read from the prompt cache. */
  cacheRead?: number;
  /** Input written to the prompt cache. */
  cacheWrite?: number;
  /** A second rate card for long prompts (Haiku 5.5 above 100K tokens). */
  above?: { tokens: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

/** A model's own reply blocks, kept so they can be sent back unchanged (Claude's thinking blocks). */
export interface NativeContent {
  provider: 'anthropic';
  model: string;
  content: unknown[];
}

export interface ImageAttachment {
  mediaType: string;
  /** base64 data */
  data: string;
}

export interface MessageMeta {
  provider?: string;
  model?: string;
  ts?: number;
  /** Synthetic messages are inserted by FreeCode (summaries, nudges). */
  synthetic?: boolean;
  kind?: 'summary' | 'nudge' | 'interrupted' | 'queued' | 'command' | 'memory' | 'bash' | 'attachment' | 'screenshot';
  /** Turn index this message belongs to. */
  turn?: number;
  /** Tool result was pruned during compaction. */
  pruned?: boolean;
  /** UI rendering data for tool results (diffs, todos...). Never sent to models. */
  display?: unknown;
  /** Duration of a tool call in ms (UI only). */
  durationMs?: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: ImageAttachment[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  reasoning?: string;
  isError?: boolean;
  /** The provider's exact reply blocks for this assistant turn (sent back unchanged to the same provider). */
  native?: NativeContent;
  meta?: MessageMeta;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderQuirks {
  /** Tool call ids must be exactly 9 alphanumeric characters (Mistral). */
  toolCallIdFormat?: 'mistral9';
  /** Insert an assistant message between a tool result and a following user message. */
  noUserAfterTool?: boolean;
  /** Assistant messages carrying tool calls need '' instead of null content. */
  emptyStringContent?: boolean;
  /** Request usage numbers in the final stream chunk. */
  streamUsage?: boolean;
  /** Name of the output-limit field. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** JSON schema dialect for tool parameters. */
  schemaDialect?: 'openai' | 'gemini';
  /** Prefix to strip from model ids returned by /models. */
  stripModelPrefix?: string;
  /** Provider does not accept the `tool_choice` field. */
  noToolChoice?: boolean;
  /** Tool messages must carry the tool `name`. */
  toolMessageName?: boolean;
  /** Always send max tokens (provider default is tiny). */
  requireMaxTokens?: boolean;
  /** Never send `temperature`: Claude 4.7 and later and OpenAI's reasoning models only accept the default. */
  noTemperature?: boolean;
  /** Gemini 3: tool calls carry thought signatures (extra_content) that must be sent back. */
  thoughtSignatures?: boolean;
  /** How the effort level reaches models that take one: `reasoning_effort`, or OpenRouter's `reasoning.effort`. */
  reasoningEffort?: 'openai' | 'openrouter';
}

export type ProviderKind = 'free' | 'keyless' | 'local' | 'trial' | 'paid';

export interface SeedModel {
  id: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  tools?: ToolMode | 'none';
  quality?: number;
  speed?: number;
  reasoning?: boolean;
  vision?: boolean;
  /** Takes an effort level (Claude 5, GPT-5, gpt-oss). */
  effort?: boolean;
  /** For paid models: what a request costs. */
  price?: ModelPrice;
  limits?: RateLimits;
  extraBody?: Record<string, unknown>;
  roles?: ModelRole[];
  /** Model ignores the system role (merge it into the first user message). */
  noSystemRole?: boolean;
  /** Added to the router score (negative keeps a costly model for when it is picked by name). */
  priority?: number;
}

export type ModelRole = 'router' | 'summarizer';

export interface DiscoveredModel {
  id: string;
  name?: string;
  context?: number;
  maxOutput?: number;
  tools?: boolean;
  vision?: boolean;
  free?: boolean;
  deprecated?: boolean;
}

export interface DiscoveryDef {
  type: 'openai' | 'openrouter' | 'ollama' | 'none';
  /** Keep only models matching this predicate. */
  filter?: (m: DiscoveredModel) => boolean;
  /** Keep only models flagged as free. */
  freeOnly?: boolean;
  /** Maximum number of discovered models to keep (best-estimated first). */
  limit?: number;
  /** The models endpoint works without an API key. */
  public?: boolean;
  /** Minimum estimated quality for discovered models to be kept. */
  minQuality?: number;
}

export interface ProviderDef {
  id: string;
  name: string;
  /** May contain {accountId}. */
  baseURL: string;
  api?: 'openai' | 'ollama' | 'anthropic';
  keyEnv: string[];
  keyRequired: boolean;
  /** Key to send when the user has none (keyless providers). */
  anonymousKey?: string;
  accountIdEnv?: string[];
  signupUrl: string;
  keyUrl?: string;
  /** One-line description of what is free. */
  freeTier: string;
  kind: ProviderKind;
  headers?: Record<string, string>;
  quirks?: ProviderQuirks;
  /** Limits shared by all models of this provider. */
  limits?: RateLimits;
  models: SeedModel[];
  discovery?: DiscoveryDef;
  notes?: string;
  /** For keyless/local providers: probe before use. */
  probe?: boolean;
  /** Typical speed score used for discovered models (0-100). */
  speed?: number;
  /** Base URL override environment variable (e.g. OLLAMA_HOST). */
  baseURLEnv?: string;
}

export interface ModelInfo {
  /** "provider/model" */
  key: string;
  providerId: string;
  id: string;
  name: string;
  context: number;
  maxOutput: number;
  toolMode: ToolMode;
  quality: number;
  speed: number;
  reasoning: boolean;
  vision: boolean;
  effort: boolean;
  price?: ModelPrice;
  limits: RateLimits;
  extraBody?: Record<string, unknown>;
  roles: ModelRole[];
  source: 'seed' | 'discovered' | 'user';
  enabled: boolean;
  priority: number;
  paid: boolean;
  noSystemRole: boolean;
}

export interface ProviderRuntime {
  def: ProviderDef;
  id: string;
  name: string;
  baseURL: string;
  apiKeys: string[];
  headers: Record<string, string>;
  /** Has credentials (or needs none). */
  configured: boolean;
  enabled: boolean;
  paid: boolean;
  kind: ProviderKind;
  priority: number;
  limits: RateLimits;
  models: ModelInfo[];
  /** Reason the provider is unavailable, if any. */
  unavailableReason?: string;
}

export interface Usage {
  /** All input tokens, cached ones included. */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Input tokens read from the provider's prompt cache (billed at a fraction of the price). */
  cacheReadTokens?: number;
  /** Input tokens written to the prompt cache. */
  cacheWriteTokens?: number;
  /** What the tokens cost in US dollars (paid models with a known price). */
  costUsd?: number;
}

export interface RateLimitSnapshot {
  remainingRequests?: number;
  remainingTokens?: number;
  resetRequestsMs?: number;
  resetTokensMs?: number;
  remainingRequestsDay?: number;
  resetRequestsDayMs?: number;
  remainingTokensDay?: number;
  resetTokensDayMs?: number;
}

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: Usage;
  rateLimit?: RateLimitSnapshot;
  latencyMs: number;
  ttftMs?: number;
  native?: NativeContent;
}
