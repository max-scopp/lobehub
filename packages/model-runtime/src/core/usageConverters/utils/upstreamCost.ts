import debug from 'debug';

const log = debug('lobe-cost:upstreamCost');

/**
 * The cost an upstream reported for a call, in USD, or undefined.
 *
 * Some providers price the call themselves and say so in `usage`: OpenRouter
 * puts the credits it charged in `usage.cost`, and a LiteLLM proxy does the same
 * when `include_cost_in_streaming_usage` is on (or a callback mirrors its
 * `x-litellm-response-cost` into the body). That number is what the account was
 * actually charged — including the provider's own discounts, cache pricing and
 * routing decisions — so it beats anything computed from a local price table.
 *
 * It also rescues the case where no local price exists at all: a model reached
 * through a proxy is named by the proxy (`tensorx/z-ai/glm-5.3`,
 * `openrouter/qwen/qwen3-235b-a22b`, or a bare alias), matches no model card,
 * and is therefore displayed as free however much it cost.
 *
 * `cost_details.upstream_inference_cost` is deliberately ignored: on OpenRouter
 * that is what the underlying provider charged OpenRouter under BYOK, not what
 * the account was charged, so adding it would double-count.
 */
export const readUpstreamCost = (usage: unknown): number | undefined => {
  if (!usage || typeof usage !== 'object') return undefined;

  const reported = (usage as { cost?: unknown }).cost;

  // Only a real, finite, non-negative number is a cost. A string, a null, a
  // boolean or a NaN is a provider quirk, not a price, and must not silently
  // become 0 — that would read as "this call was free".
  if (typeof reported !== 'number' || !Number.isFinite(reported) || reported < 0) {
    if (reported !== undefined) log('ignoring a non-numeric upstream cost: %O', reported);
    return undefined;
  }

  log('upstream reported a cost of %d', reported);

  return reported;
};
