import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sandboxEnv } from '@/envs/sandbox';

import { resolveSandboxRunTTL, spawnHeteroSandbox } from '../sandboxRunner';

/** The prompt rides into the sandbox base64-encoded — decode it back out. */
const decodeStdinPayload = (command: string): string => {
  const encoded = command.match(/^echo '([^']+)' \| base64 -d/)?.[1];
  if (!encoded) throw new Error(`No base64 stdin payload in command: ${command}`);
  return Buffer.from(encoded, 'base64').toString('utf8');
};

const { mockCallTool } = vi.hoisted(() => ({
  mockCallTool: vi.fn().mockResolvedValue({ success: true }),
}));

vi.mock('@/envs/app', () => ({
  appEnv: { APP_URL: 'https://app.example.com' },
}));

vi.mock('@/envs/sandbox', () => ({
  sandboxEnv: { HETERO_SANDBOX_FORWARD_ENV: undefined, HETERO_SANDBOX_RUN_TTL_SEC: undefined },
}));

const forwardEnv = (value: string | undefined) => {
  (sandboxEnv as { HETERO_SANDBOX_FORWARD_ENV?: string }).HETERO_SANDBOX_FORWARD_ENV = value;
};

const { mockSandboxKind } = vi.hoisted(() => ({
  mockSandboxKind: { current: 'market' as 'market' | 'onlyboxes' },
}));

vi.mock('@/server/services/sandbox', () => ({
  createSandboxService: vi.fn(() => ({
    callTool: mockCallTool,
    kind: mockSandboxKind.current,
  })),
}));

describe('spawnHeteroSandbox', () => {
  beforeEach(() => {
    mockCallTool.mockClear();
    mockCallTool.mockResolvedValue({ success: true });
  });

  it('forwards resolved selector args to lh hetero exec', async () => {
    await spawnHeteroSandbox({
      agentType: 'claude-code',
      args: ['--model', 'opus', '--effort', 'high'],
      assistantMessageId: 'msg-1',
      jwt: 'jwt',
      marketService: {} as any,
      operationId: 'op-1',
      prompt: 'hi',
      topicId: 'topic-1',
      userId: 'user-1',
    });

    expect(mockCallTool).toHaveBeenCalledWith(
      'runCommand',
      expect.objectContaining({
        command: expect.stringContaining("'--model' 'opus' '--effort' 'high'"),
      }),
    );
  });

  it('shell-escapes selector args before interpolating the sandbox command', async () => {
    await spawnHeteroSandbox({
      agentType: 'claude-code',
      args: ['--model', '$(touch /tmp/pwned)', '--effort', "hi'there"],
      assistantMessageId: 'msg-1',
      jwt: 'jwt',
      marketService: {} as any,
      operationId: 'op-1',
      prompt: 'hi',
      topicId: 'topic-1',
      userId: 'user-1',
    });

    const command = mockCallTool.mock.calls[0][1].command;
    expect(command).toContain("'$(touch /tmp/pwned)'");
    expect(command).toContain("'hi'\\''there'");
    expect(command).not.toContain('"$(touch /tmp/pwned)"');
  });

  it('injects LOBEHUB_WORKSPACE_ID when the topic belongs to a workspace', async () => {
    await spawnHeteroSandbox({
      agentType: 'claude-code',
      assistantMessageId: 'msg-1',
      jwt: 'jwt',
      marketService: {} as any,
      operationId: 'op-1',
      prompt: 'hi',
      topicId: 'topic-1',
      userId: 'user-1',
      workspaceId: 'ws-lobehub',
    });

    const command = mockCallTool.mock.calls[0][1].command;
    expect(command).toContain("LOBEHUB_WORKSPACE_ID='ws-lobehub'");
  });
});

describe('spawnHeteroSandbox forwarded environment', () => {
  const run = () =>
    spawnHeteroSandbox({
      agentType: 'opencode',
      assistantMessageId: 'msg-1',
      jwt: 'jwt',
      marketService: {} as any,
      operationId: 'op-1',
      prompt: 'hi',
      topicId: 'topic-1',
      userId: 'user-1',
    });

  const lastCommand = () => mockCallTool.mock.calls.at(-1)?.[1].command as string;

  beforeEach(() => {
    mockCallTool.mockClear();
    mockCallTool.mockResolvedValue({ success: true });
    forwardEnv(undefined);
    delete process.env.OPENCODE_CONFIG_CONTENT;
    delete process.env.NOT_ALLOWLISTED;
  });

  it('forwards nothing when the deployment has not opted in', async () => {
    process.env.OPENCODE_CONFIG_CONTENT = '{"model":"x"}';

    await run();

    expect(lastCommand()).not.toContain('OPENCODE_CONFIG_CONTENT=');
  });

  it('forwards an allowlisted variable, shell-quoted', async () => {
    process.env.OPENCODE_CONFIG_CONTENT = '{"model":"it\'s fine"}';
    forwardEnv('OPENCODE_CONFIG_CONTENT');

    await run();

    // Single quotes inside the value must not close the quoting and leak the
    // rest of the config into the command line as shell words.
    expect(lastCommand()).toContain(`OPENCODE_CONFIG_CONTENT='{"model":"it'\\''s fine"}'`);
  });

  it('leaves out an allowlisted variable that is unset', async () => {
    forwardEnv('OPENCODE_CONFIG_CONTENT');

    await run();

    expect(lastCommand()).not.toContain('OPENCODE_CONFIG_CONTENT=');
  });

  it('never forwards a variable the allowlist does not name', async () => {
    process.env.NOT_ALLOWLISTED = 'secret';
    forwardEnv('OPENCODE_CONFIG_CONTENT');

    await run();

    expect(lastCommand()).not.toContain('NOT_ALLOWLISTED');
  });
});

describe('spawnHeteroSandbox on Onlyboxes', () => {
  const params = {
    agentType: 'opencode' as const,
    assistantMessageId: 'msg-1',
    jwt: 'jwt',
    marketService: {} as any,
    operationId: 'op-1',
    prompt: 'hi',
    topicId: 'topic-1',
    userId: 'user-1',
  };

  beforeEach(() => {
    mockCallTool.mockClear();
    mockCallTool.mockResolvedValue({ success: true });
    mockSandboxKind.current = 'onlyboxes';
  });

  afterEach(() => {
    mockSandboxKind.current = 'market';
  });

  it('detaches the run so it outlives the ten-minute task', async () => {
    await spawnHeteroSandbox(params);

    const [, input] = mockCallTool.mock.calls[0];
    expect(input.background).toBeUndefined();
    expect(input.timeout).toBeLessThanOrEqual(600_000);
    expect(input.command).toMatch(/^setsid nohup sh -c '/);
    expect(input.command).toMatch(/> '\/tmp\/lobe-hetero-op-1\.log' 2>&1 < \/dev\/null &$/);
  });

  it('keeps the whole run, prompt included, inside the detached shell', async () => {
    await spawnHeteroSandbox(params);

    const command: string = mockCallTool.mock.calls[0][1].command;
    const inner = command.match(/^setsid nohup sh -c '(.*)' > /s)?.[1] ?? '';
    const unquoted = inner.replaceAll("'\\''", "'");
    expect(decodeStdinPayload(unquoted)).toContain('hi');
    expect(unquoted).toContain("'lh' 'hetero' 'exec' '--type' 'opencode'");
  });

  it('keeps the background task on the Market sandbox', async () => {
    mockSandboxKind.current = 'market';
    await spawnHeteroSandbox(params);

    expect(mockCallTool.mock.calls[0][1]).toEqual(
      expect.objectContaining({ background: true, timeout: 600_000 }),
    );
  });
});

describe('resolveSandboxRunTTL', () => {
  const runTTL = (value: number | undefined) => {
    (sandboxEnv as { HETERO_SANDBOX_RUN_TTL_SEC?: number }).HETERO_SANDBOX_RUN_TTL_SEC = value;
  };

  afterEach(() => runTTL(undefined));

  it('defaults to four hours', () => {
    expect(resolveSandboxRunTTL()).toBe('14400s');
  });

  it('follows HETERO_SANDBOX_RUN_TTL_SEC', () => {
    runTTL(43_200);
    expect(resolveSandboxRunTTL()).toBe('43200s');
  });
});
