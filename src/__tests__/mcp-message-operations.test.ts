import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendTaktMessage, listTaktRecentMessages, type MessageOperationDependencies } from '../features/mcp/messageOperations.js';
import { firstTextContent } from './helpers/mcp-content.js';

const doubles = vi.hoisted(() => ({ root: vi.fn(), repository: vi.fn(), assignment: vi.fn() }));
vi.mock('../features/mcp/operations.js', async (original) => ({
  ...await original<typeof import('../features/mcp/operations.js')>(), assertCwdAllowedByMcpRoot: doubles.root,
}));
vi.mock('../infra/task/repositoryDirectory.js', () => ({ resolveGitRepositoryDirectory: doubles.repository }));
vi.mock('../features/manager/assignment.js', () => ({ resolveCurrentManagerAssignment: doubles.assignment }));

describe('MCP conversation operations', () => {
  const operationId = '550e8400-e29b-41d4-a716-446655440001';
  const client = { connect: vi.fn(), submit: vi.fn(), recentMessages: vi.fn(), close: vi.fn() };
  const deps: MessageOperationDependencies = { allowedProjectRoot: '/allowed', configDirectory: '/test-config',
    createClient: vi.fn(() => client) };
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(deps.createClient).mockReturnValue(client);
    doubles.repository.mockResolvedValue('/allowed/repo');
    doubles.assignment.mockResolvedValue({ kind: 'workspace', workspaceId: '550e8400-e29b-41d4-a716-446655440000' });
    client.connect.mockResolvedValue(undefined);
    client.submit.mockResolvedValue({ kind: 'accepted', operationId });
    client.recentMessages.mockResolvedValue({ messages: [], truncated: false });
  });
  it('sends once to the current manager and returns durable acceptance', async () => {
    const result = await sendTaktMessage({ recipient: 'manager', cwd: '/allowed/repo', text: ' body\n' }, deps);
    expect(result.isError).toBeUndefined();
    expect(deps.createClient).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', workspaceId: '550e8400-e29b-41d4-a716-446655440000' });
    expect(client.submit).toHaveBeenCalledExactlyOnceWith({ kind: 'message', text: ' body\n' });
    expect(JSON.parse(firstTextContent(result.content))).toEqual({ kind: 'accepted', operationId, recipient: 'manager' });
    expect(client.close).toHaveBeenCalledOnce();
  });
  it('opens only the daemon conversation for a director message', async () => {
    expect((await sendTaktMessage({ recipient: 'director', text: 'ask a manager' }, deps)).isError).toBeUndefined();
    expect(deps.createClient).toHaveBeenCalledExactlyOnceWith({ kind: 'daemon' });
    expect(doubles.repository).not.toHaveBeenCalled();
    expect(doubles.assignment).not.toHaveBeenCalled();
    expect(client.submit).toHaveBeenCalledExactlyOnceWith({ kind: 'message', text: 'ask a manager' });
  });
  it('reads the selected conversation with its limit and preserves speakers and relay origin', async () => {
    const identity = { conversationId: 'manager', operationId: 'relay', acceptedSequence: 1, status: 'completed', truncated: false };
    const messages = [{ ...identity, kind: 'message', speaker: 'human', text: 'relayed', origin: 'human', directorConversationId: 'director', operationId: 'relay' },
      { ...identity, kind: 'reply', speaker: 'manager', text: 'reply' }];
    client.recentMessages.mockResolvedValue({ messages, truncated: false });
    const result = await listTaktRecentMessages({ recipient: 'manager', cwd: '/allowed/repo', limit: 2 }, deps);
    expect(result.isError).toBeUndefined();
    expect(client.recentMessages).toHaveBeenCalledExactlyOnceWith(2);
    expect(JSON.parse(firstTextContent(result.content))).toEqual({ recipient: 'manager', messages, truncated: false });
    expect(client.submit).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledOnce();
  });
  it.each([
    { recipient: 'unknown', text: 'body' }, { recipient: 'manager', text: 'body' },
    { recipient: 'director', cwd: '/allowed/repo', text: 'body' },
    { recipient: 'director', text: '' }, { recipient: 'director', text: ' \n\t ' },
  ])('rejects invalid sending input before connecting %#', async (input) => {
    expect((await sendTaktMessage(input, deps)).isError).toBe(true);
    expect(deps.createClient).not.toHaveBeenCalled();
    expect(client.submit).not.toHaveBeenCalled();
  });
  it('rejects an invalid read before connecting', async () => {
    expect((await listTaktRecentMessages({ recipient: 'director', limit: 0 }, deps)).isError).toBe(true);
    expect(deps.createClient).not.toHaveBeenCalled();
  });
  it('rejects a repository outside the MCP root before connecting', async () => {
    doubles.root.mockImplementation(() => { throw new Error('outside root'); });
    expect((await sendTaktMessage({ recipient: 'manager', cwd: '/other', text: 'body' }, deps)).isError).toBe(true);
    expect(deps.createClient).not.toHaveBeenCalled();
  });
  it.each(['connect', 'submit', 'recentMessages'] as const)('closes after %s fails without retrying', async (operation) => {
    client[operation].mockRejectedValue(new Error('unavailable'));
    const result = operation === 'recentMessages'
      ? await listTaktRecentMessages({ recipient: 'director' }, deps) : await sendTaktMessage({ recipient: 'director', text: 'once' }, deps);
    expect(result.isError).toBe(true);
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(client.submit.mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('returns an MCP error when admission is refused without retrying', async () => {
    client.submit.mockResolvedValue({ kind: 'error', code: 'storage_error', message: 'not saved' });
    expect((await sendTaktMessage({ recipient: 'director', text: 'once' }, deps)).isError).toBe(true);
    expect(client.submit).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });
});
