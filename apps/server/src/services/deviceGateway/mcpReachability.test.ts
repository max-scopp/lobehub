import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  MCP_PRIVATE_HOST_ALLOWLIST: undefined as string | undefined,
}));

vi.mock('@/envs/gateway', () => ({ gatewayEnv: mockEnv }));

const { isDeviceOnlyMcpEndpoint, isServerReachableMcpUrl } = await import('./mcpReachability');

const PRIVATE = 'http://192.168.2.156:4000/mcp';
const OTHER_PRIVATE = 'http://192.168.2.171:4041/mcp';

beforeEach(() => {
  mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = undefined;
});

describe('isServerReachableMcpUrl', () => {
  it('is false for everything when no allowlist is configured', () => {
    expect(isServerReachableMcpUrl(PRIVATE)).toBe(false);
  });

  it('matches an allowlisted host regardless of scheme, port and path', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isServerReachableMcpUrl(PRIVATE)).toBe(true);
    expect(isServerReachableMcpUrl('https://192.168.2.156:8443/other')).toBe(true);
  });

  it('does not match a different host in the same private range', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isServerReachableMcpUrl(OTHER_PRIVATE)).toBe(false);
  });

  // The allowlist exists to exempt named hosts, not to punch a hole in the
  // private range. A prefix or suffix rule would exempt `10.0.0.9` and
  // `lan.evil.com` along with `lan` — i.e. everything it protects.
  it('matches whole hostnames only, never a prefix or suffix', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '10.0.0.5,lan';
    expect(isServerReachableMcpUrl('http://10.0.0.5:8080/mcp')).toBe(true);
    expect(isServerReachableMcpUrl('http://10.0.0.50:8080/mcp')).toBe(false);
    expect(isServerReachableMcpUrl('http://x.lan/mcp')).toBe(false);
    expect(isServerReachableMcpUrl('http://lan.evil.com/mcp')).toBe(false);
  });

  it('ignores case and surrounding whitespace', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '  192.168.2.156 , LITELLM.LAN  ';
    expect(isServerReachableMcpUrl(PRIVATE)).toBe(true);
    expect(isServerReachableMcpUrl('http://litellm.lan:4000/mcp')).toBe(true);
  });

  it('reparses when the configured value changes', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isServerReachableMcpUrl(OTHER_PRIVATE)).toBe(false);
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.171';
    expect(isServerReachableMcpUrl(OTHER_PRIVATE)).toBe(true);
  });

  it('treats an empty or whitespace-only list as no allowlist', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = ' , ,';
    expect(isServerReachableMcpUrl(PRIVATE)).toBe(false);
  });

  it('never exempts a malformed URL', () => {
    // Defaulting to "not reachable" keeps this function from ever being the
    // reason a bad URL is let through; the callers validate it separately.
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = 'not a url';
    expect(isServerReachableMcpUrl('not a url')).toBe(false);
  });
});

describe('isDeviceOnlyMcpEndpoint', () => {
  it('treats a private-network http endpoint as device-only on a cloud deployment', () => {
    expect(isDeviceOnlyMcpEndpoint('http', PRIVATE, true)).toBe(true);
  });

  // The regression: a homelab server that shares a LAN with its MCP servers had
  // every one of them classified device-only, so the tool call was refused with
  // a message about a machine that was never involved.
  it('exempts an allowlisted private host', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isDeviceOnlyMcpEndpoint('http', PRIVATE, true)).toBe(false);
  });

  it('keeps an unlisted private host device-only even when others are allowlisted', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isDeviceOnlyMcpEndpoint('http', OTHER_PRIVATE, true)).toBe(true);
  });

  it('never exempts stdio, which no server can reach', () => {
    // An allowlist entry cannot conjure the binary onto the server, and a stdio
    // connector has no URL to match an entry against anyway.
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isDeviceOnlyMcpEndpoint('stdio', null, true)).toBe(true);
  });

  it('is never device-only when no device gateway is configured', () => {
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = '192.168.2.156';
    expect(isDeviceOnlyMcpEndpoint('http', PRIVATE, false)).toBe(false);
    expect(isDeviceOnlyMcpEndpoint('stdio', null, false)).toBe(false);
  });

  it('is false for a public endpoint, allowlisted or not', () => {
    expect(isDeviceOnlyMcpEndpoint('http', 'https://mcp.example.com', true)).toBe(false);
    mockEnv.MCP_PRIVATE_HOST_ALLOWLIST = 'mcp.example.com';
    expect(isDeviceOnlyMcpEndpoint('http', 'https://mcp.example.com', true)).toBe(false);
  });

  it('does not classify the cloud or sse transports by address', () => {
    // `cloud` is dispatched to the hosted endpoint and `sse` was never gated
    // here; widening the rule to them would change paths it does not own.
    expect(isDeviceOnlyMcpEndpoint('cloud', PRIVATE, true)).toBe(false);
    expect(isDeviceOnlyMcpEndpoint('sse', PRIVATE, true)).toBe(false);
  });

  it('handles a missing url and a missing connection type', () => {
    expect(isDeviceOnlyMcpEndpoint('http', null, true)).toBe(false);
    expect(isDeviceOnlyMcpEndpoint(null, PRIVATE, true)).toBe(false);
    expect(isDeviceOnlyMcpEndpoint(undefined, undefined, true)).toBe(false);
  });
});
