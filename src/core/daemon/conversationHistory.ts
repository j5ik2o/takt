import { z } from 'zod/v4';

export const RECENT_MESSAGES_MAX_COUNT = 50;
// Leave room for IPC and MCP envelopes, including JSON escaping.
export const RECENT_MESSAGES_MAX_BYTES = 24 * 1024;
export const RECENT_HISTORY_TEXT_BYTES = 2048;
export const RecentMessageLimitSchema = z.number().int().min(1).max(RECENT_MESSAGES_MAX_COUNT);
export const RecentMessageSchema = z.object({
  conversationId: z.string().min(1), operationId: z.string().min(1),
  acceptedSequence: z.number().int().positive(),
  speaker: z.enum(['human', 'manager', 'director', 'unknown']),
  kind: z.enum(['message', 'reply', 'result']),
  status: z.enum(['accepted', 'completed', 'failed', 'interrupted']),
  text: z.string(), truncated: z.boolean(),
  directorConversationId: z.string().optional(), origin: z.enum(['human', 'director']).optional(),
  senderConversationId: z.string().optional(),
}).strict();
export const RecentMessagesSchema = z.object({ messages: z.array(RecentMessageSchema).max(RECENT_MESSAGES_MAX_COUNT), truncated: z.boolean() }).strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= RECENT_MESSAGES_MAX_BYTES);
export type RecentMessage = z.infer<typeof RecentMessageSchema>;
export type RecentMessages = z.infer<typeof RecentMessagesSchema>;
export interface ConversationHistory {
  recentMessages(conversationId: string, limit: number, signal?: AbortSignal): Promise<RecentMessages>;
}
