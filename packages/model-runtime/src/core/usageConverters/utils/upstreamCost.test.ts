import { describe, expect, it } from 'vitest';

import { readUpstreamCost } from './upstreamCost';

describe('readUpstreamCost', () => {
  it('reads the cost a provider reported in usage', () => {
    // What OpenRouter returns, and what a LiteLLM proxy returns with
    // include_cost_in_streaming_usage on.
    expect(
      readUpstreamCost({
        completion_tokens: 1,
        cost: 0.0008902,
        prompt_tokens: 2959,
        total_tokens: 2960,
      }),
    ).toBe(0.0008902);
  });

  it('keeps an explicit zero: the upstream said this call was free', () => {
    expect(readUpstreamCost({ cost: 0, total_tokens: 10 })).toBe(0);
  });

  it('returns undefined when no cost was reported', () => {
    expect(readUpstreamCost({ prompt_tokens: 10, total_tokens: 20 })).toBeUndefined();
  });

  it.each([
    ['a string', '0.5'],
    ['null', null],
    ['a boolean', true],
    ['an object', { total: 0.5 }],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a negative number', -1],
  ])('ignores %s rather than reading it as free', (_label, cost) => {
    expect(readUpstreamCost({ cost })).toBeUndefined();
  });

  it('tolerates a missing or non-object usage', () => {
    expect(readUpstreamCost(undefined)).toBeUndefined();
    expect(readUpstreamCost(null)).toBeUndefined();
    expect(readUpstreamCost('usage')).toBeUndefined();
  });

  it('ignores cost_details, which is what the provider paid, not what we were charged', () => {
    expect(
      readUpstreamCost({ cost_details: { upstream_inference_cost: 0.004 }, total_tokens: 10 }),
    ).toBeUndefined();
  });
});
