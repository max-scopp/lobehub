import type { ModelUsage } from '@lobechat/types';
import type { Pricing } from 'model-bank';

import type { ComputeChatCostOptions } from './computeChatCost';
import { computeChatCost } from './computeChatCost';

export const withUsageCost = (
  usage: ModelUsage,
  pricing?: Pricing,
  options?: ComputeChatCostOptions,
  /**
   * A cost the upstream reported for this call (see `readUpstreamCost`). It wins
   * over the local computation: it is what the account was actually charged, and
   * it is often the only figure that exists — a model reached through a proxy
   * matches no model card, so `pricing` is undefined and the call would
   * otherwise be reported as free.
   */
  upstreamCost?: number,
): ModelUsage => {
  if (typeof upstreamCost === 'number') return { ...usage, cost: upstreamCost };

  if (!pricing) return usage;

  const pricingResult = computeChatCost(pricing, usage, options);
  if (!pricingResult) return usage;

  return { ...usage, cost: pricingResult.totalCost };
};
