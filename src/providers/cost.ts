// What a request cost, from a model's price card and the token counts the provider reported.
import type { ModelPrice, Usage } from './types.js';

/** US dollars for one request, or undefined when the model has no known price. */
export function requestCost(price: ModelPrice | undefined, u: Usage): number | undefined {
  if (!price) return undefined;
  const card = price.above && u.promptTokens > price.above.tokens ? price.above : price;
  const read = u.cacheReadTokens ?? 0;
  const write = u.cacheWriteTokens ?? 0;
  const fresh = Math.max(0, u.promptTokens - read - write);
  return (fresh * card.input + read * (card.cacheRead ?? card.input) + write * (card.cacheWrite ?? card.input) + u.completionTokens * card.output) / 1e6;
}

/** "$0.42", or more digits for amounts under a cent. */
export function formatUsd(usd: number): string {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}
