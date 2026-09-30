import debug from 'debug';

import { sandboxEnv } from '@/envs/sandbox';

const log = debug('lobe-server:hetero-litellm-run-key');

/**
 * A LiteLLM key minted for one sandbox run.
 *
 * A coding CLI in the sandbox calls LiteLLM directly, so LobeHub never sees a
 * price: OpenCode prices a call from its own model table, and a router model
 * such as `code/auto` has no single price to put there. A key per run hands
 * both jobs to the one place that prices every call: LiteLLM refuses the run's
 * calls once its budget is spent, and the key's spend is the run's exact cost.
 *
 * The key is found again by its alias, so nothing about it has to be stored.
 */
const runKeyAlias = (operationId: string) => `lobehub-run-${operationId}`;

const REQUEST_TIMEOUT_MS = 15_000;

const isConfigured = () =>
  Boolean(sandboxEnv.HETERO_SANDBOX_LITELLM_URL && sandboxEnv.HETERO_SANDBOX_LITELLM_ADMIN_KEY);

const callLiteLLM = async (path: string, init?: { body?: unknown; method?: 'GET' | 'POST' }) => {
  const response = await fetch(new URL(path, sandboxEnv.HETERO_SANDBOX_LITELLM_URL), {
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    headers: {
      'Authorization': `Bearer ${sandboxEnv.HETERO_SANDBOX_LITELLM_ADMIN_KEY}`,
      'Content-Type': 'application/json',
    },
    method: init?.method ?? 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`LiteLLM ${path} answered ${response.status}: ${await response.text()}`);
  }
  return response.json();
};

export interface RunKey {
  /** The run's budget in USD, when one is configured. */
  budgetUsd?: number;
  key: string;
}

/**
 * Mint the run's key. Returns undefined when per-run keys are not configured,
 * or when LiteLLM refuses: the run then falls back to the forwarded shared key.
 */
export const mintRunKey = async (params: {
  operationId: string;
  topicId: string;
  ttlSec: number;
}): Promise<RunKey | undefined> => {
  if (!isConfigured()) return undefined;

  const budgetUsd = sandboxEnv.HETERO_SANDBOX_RUN_BUDGET_USD;
  try {
    const result = await callLiteLLM('/key/generate', {
      body: {
        duration: `${params.ttlSec}s`,
        key_alias: runKeyAlias(params.operationId),
        ...(budgetUsd !== undefined && { max_budget: budgetUsd }),
        metadata: {
          operationId: params.operationId,
          source: 'lobehub-hetero-sandbox',
          topicId: params.topicId,
        },
        ...(sandboxEnv.HETERO_SANDBOX_LITELLM_USER && {
          user_id: sandboxEnv.HETERO_SANDBOX_LITELLM_USER,
        }),
      },
      method: 'POST',
    });
    if (typeof result?.key !== 'string') throw new Error('LiteLLM returned no key');
    return { budgetUsd, key: result.key };
  } catch (error) {
    log('mintRunKey: op=%s failed, run falls back to the shared key: %O', params.operationId, error);
    return undefined;
  }
};

/** What the run's key has spent so far, in USD; undefined when there is no run key. */
export const readRunSpend = async (operationId: string): Promise<number | undefined> => {
  if (!isConfigured()) return undefined;

  try {
    const alias = encodeURIComponent(runKeyAlias(operationId));
    const result = await callLiteLLM(`/key/list?key_alias=${alias}&return_full_object=true`);
    const spend = result?.keys?.[0]?.spend;
    return typeof spend === 'number' && Number.isFinite(spend) ? spend : undefined;
  } catch (error) {
    log('readRunSpend: op=%s failed: %O', operationId, error);
    return undefined;
  }
};

/** Delete the run's key once the run is over. Its spend stays in LiteLLM's logs. */
export const revokeRunKey = async (operationId: string): Promise<void> => {
  if (!isConfigured()) return;

  try {
    await callLiteLLM('/key/delete', {
      body: { key_aliases: [runKeyAlias(operationId)] },
      method: 'POST',
    });
  } catch (error) {
    log('revokeRunKey: op=%s failed: %O', operationId, error);
  }
};
