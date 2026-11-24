import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod/v4';
import type { ConversationAssignment } from '../../infra/conversations/schema.js';
import { resolveGitRepositoryDirectory } from '../../infra/task/repositoryDirectory.js';
import { resolveCurrentManagerAssignment } from '../manager/assignment.js';
import type { ConversationIpcClient } from '../manager/conversationIpcClient.js';
import { assertCwdAllowedByMcpRoot, errorResult } from './operations.js';
import { jsonResult } from './response.js';
import { sendMessageInputSchema, listRecentMessagesInputSchema } from './schemas.js';

export type MessageConversationClient = Pick<ConversationIpcClient, 'connect' | 'submit' | 'recentMessages' | 'close'>;
export interface MessageOperationDependencies {
  allowedProjectRoot: string;
  configDirectory: string;
  createClient(assignment: ConversationAssignment): MessageConversationClient;
}

async function messageOperation<T extends { recipient: 'manager' | 'director'; cwd?: string }>(
  raw: unknown, schema: z.ZodType<T>, deps: MessageOperationDependencies,
  action: (client: MessageConversationClient, input: T) => Promise<CallToolResult>,
): Promise<CallToolResult> {
  let client: MessageConversationClient | undefined;
  try {
    const input = schema.parse(raw);
    let assignment: ConversationAssignment;
    if (input.recipient === 'director') assignment = { kind: 'daemon' };
    else {
      if (input.cwd === undefined) throw new Error('manager requires cwd');
      assertCwdAllowedByMcpRoot(input.cwd, deps.allowedProjectRoot);
      const repositoryDirectory = await resolveGitRepositoryDirectory(input.cwd);
      assertCwdAllowedByMcpRoot(repositoryDirectory, deps.allowedProjectRoot);
      assignment = await resolveCurrentManagerAssignment({ kind: 'repository', repositoryDirectory }, deps.configDirectory);
    }
    client = deps.createClient(assignment);
    await client.connect();
    return await action(client, input);
  } catch (error) { return errorResult('Conversation operation failed', error); }
  finally { client?.close(); }
}

export function sendTaktMessage(input: unknown, deps: MessageOperationDependencies): Promise<CallToolResult> {
  return messageOperation(input, sendMessageInputSchema, deps, async (client, value) => {
    const submission = await client.submit({ kind: 'message', text: value.text });
    if (submission.kind === 'error') throw new Error(submission.message);
    return jsonResult({ ...submission, recipient: value.recipient });
  });
}

export function listTaktRecentMessages(input: unknown, deps: MessageOperationDependencies): Promise<CallToolResult> {
  return messageOperation(input, listRecentMessagesInputSchema, deps, async (client, value) =>
    jsonResult({ recipient: value.recipient, ...await client.recentMessages(value.limit ?? 20) }));
}
