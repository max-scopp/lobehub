import { isLocalOrPrivateUrl } from '@lobechat/utils';

import { ConnectorMcpConnectionType } from '@/database/schemas';
import { gatewayEnv } from '@/envs/gateway';

/**
 * Hosts the operator has declared reachable by this server itself.
 *
 * Parsed lazily and memoized on the raw env string: the env object is a live mock
 * in tests, so the value has to be read per call rather than captured at import
 * time, while a tool call on the hot path should not re-split the string. The
 * cache is keyed on the raw value, so a changed value reparses.
 */
let cachedRaw: string | undefined;
let cachedHosts = new Set<string>();

const allowlistedHosts = (): Set<string> => {
  const raw = gatewayEnv.MCP_PRIVATE_HOST_ALLOWLIST;
  if (raw === cachedRaw) return cachedHosts;

  cachedRaw = raw;
  cachedHosts = new Set(
    (raw ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
  return cachedHosts;
};

/**
 * Is this URL a private-network endpoint the server has been told it can reach?
 *
 * Only consulted for URLs that already failed `isLocalOrPrivateUrl`, so this
 * never widens the exempt set to public hosts. Matching is an exact,
 * case-insensitive hostname comparison: an allowlist that matched by suffix or
 * prefix would be one `attacker.com` away from exempting the whole range it
 * exists to protect.
 *
 * A malformed URL is not exempt. Callers validate the URL separately, and
 * defaulting to "unreachable" keeps this function from ever being the reason a
 * bad URL is allowed through.
 */
export const isServerReachableMcpUrl = (url: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowlistedHosts().has(hostname);
};

/**
 * Must this MCP endpoint run on the user's own device rather than on the server?
 *
 * The single answer to that question, shared by every caller that has to decide
 * (connector tool exec, stale-tool-list refresh, the toolExecution path). It
 * used to be re-derived inline at each of them, which is how a fix applied to
 * one site leaves the others still skipping or still throwing.
 *
 * Use when:
 * - dispatching or refreshing a connector's tools, before choosing between an
 *   in-process call and a device tunnel
 *
 * Expects:
 * - `gatewayConfigured`, normally `deviceGateway.isConfigured`, passed in rather
 *   than read here so this module stays independent of the gateway singleton
 *   (and so callers keep control of when that state is evaluated)
 *
 * Returns:
 * - true for stdio (the binary lives on the user's machine; no server can reach
 *   it) and for an `http` endpoint on a private-network host the server was not
 *   told it can reach. false for public endpoints, for the `cloud` and `sse`
 *   transports, for self-hosted servers with no gateway configured, and for
 *   allowlisted private hosts.
 */
export const isDeviceOnlyMcpEndpoint = (
  connectionType: ConnectorMcpConnectionType | string | null | undefined,
  url: string | null | undefined,
  gatewayConfigured: boolean,
): boolean => {
  // No gateway configured means no cloud: a self-hosted server may share a LAN
  // with the endpoint and legitimately reach it in-process.
  if (!gatewayConfigured) return false;

  if (connectionType === ConnectorMcpConnectionType.stdio) return true;

  // Only the `http` transport is classified by address. `cloud` is dispatched to
  // the hosted endpoint and `sse` has never been gated here; widening the check
  // to them would change paths this rule does not own.
  if (connectionType !== ConnectorMcpConnectionType.http) return false;
  if (!url || !isLocalOrPrivateUrl(url)) return false;

  return !isServerReachableMcpUrl(url);
};
