import { createHash } from 'node:crypto';
import { addAbortListener } from 'node:events';
import { opendir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AcceptedEvent } from '../../core/daemon/events.js';
import type { TurnIdentity, TurnResult } from '../../core/daemon/messages.js';
import type { ConversationTurns, EventStore, StoredEvent } from '../../core/daemon/ports.js';
import type { ConversationAssignment } from '../conversations/schema.js';
import { AcceptedEventSchema, EventRecordSchema, EventRecordWriteSchema, isRetiredWatchEvent, storedStandaloneInboxAnswer, TurnResultSchema, StoredTurnSchema, type EventRecord } from './eventRecord.js';
import { ensurePrivateDirectory, hasCode, readEntirePrivateFile, writePrivateFile } from './privateFile.js';
import { FileAsyncLock } from './lock.js';
import { ConversationStateStore } from './conversationStateStore.js';
import { DaemonPersistedFiles } from './persistedFiles.js';
import { conversationId } from '../conversations/identity.js';
import { RecentMessageLimitSchema, RECENT_HISTORY_TEXT_BYTES, RECENT_MESSAGES_MAX_BYTES, type RecentMessage, type RecentMessages } from '../../core/daemon/conversationHistory.js';
import { truncateUtf8 } from '../../shared/utils/utf8.js';

const fileKey = (id: string): string => createHash('sha256').update(id).digest('hex');
const requestKey = (event: AcceptedEvent): string => JSON.stringify([event.conversationId, event.requestId]);

export class FileEventStore implements EventStore, ConversationTurns {
  private readonly directory: string;
  private readonly ids = new Map<string, string>();
  private readonly requests = new Map<string, string>();
  private readonly sequences = new Map<number, string>();
  private readonly byConversation = new Map<string, Map<string, string>>();
  private readonly knownFiles = new Set<string>();
  private readonly lock = new FileAsyncLock();
  private readonly conversations: ConversationStateStore;
  private readonly files: DaemonPersistedFiles;
  private lastSequence = 0;
  private historyAccess: Promise<void> = Promise.resolve();

  constructor(configDirectory: string, private readonly routing?: {
    permits(assignment: ConversationAssignment, id: string, signal?: AbortSignal): Promise<boolean>;
  }) {
    this.directory = join(configDirectory, 'daemon-events');
    this.conversations = new ConversationStateStore(configDirectory);
    this.files = new DaemonPersistedFiles(configDirectory);
  }

  private exclusive<T>(action: () => Promise<T>): Promise<T> {
    return this.lock.exclusive(join(this.directory, '.lock'), action, { signal: new AbortController().signal, timeoutMs: 5000 });
  }

  private async serializeHistory<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.historyAccess;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    // A cancelled waiter must not let its successor overtake an unfinished admission.
    this.historyAccess = previous.then(() => held);
    let listener: ReturnType<typeof addAbortListener> | undefined;
    try {
      signal?.throwIfAborted();
      if (signal === undefined) await previous;
      else await Promise.race([previous, new Promise<never>((_resolve, reject) => {
        listener = addAbortListener(signal, () => reject(signal.reason));
      })]);
      signal?.throwIfAborted();
      return await action();
    } finally { listener?.[Symbol.dispose](); release(); }
  }

  private async read(path: string, signal?: AbortSignal): Promise<EventRecord> {
    signal?.throwIfAborted();
    const content = await readEntirePrivateFile(path, signal);
    if (content === undefined) throw new Error(`Missing stored event: ${path}`);
    const input: unknown = JSON.parse(content.toString('utf8'));
    const record = EventRecordSchema.parse(input);
    if (path !== this.path(record.event.eventId)) throw new Error('Stored event identity mismatch');
    if (record.state === 'running') this.assertTurn(record.event, record.turn);
    if (record.state === 'settling' || record.state === 'settled') this.assertResult(record.event, record.result);
    const event = await this.restoreStandaloneInboxAnswer(record.event, signal);
    if (record.state === 'settling' || record.state === 'settled') return { ...record, event, result: { ...record.result, event } };
    return { ...record, event };
  }

  private async restoreStandaloneInboxAnswer(saved: AcceptedEvent, signal?: AbortSignal): Promise<AcceptedEvent> {
    signal?.throwIfAborted();
    const answer = storedStandaloneInboxAnswer(saved);
    if (answer === undefined || saved.event.kind !== 'director_message' || this.routing === undefined) return saved;
    const savedAssignment = (await this.conversations.read(saved.conversationId, signal))?.state.assignment;
    signal?.throwIfAborted();
    if (savedAssignment === undefined || savedAssignment.kind === 'daemon') return saved;
    const repositories = savedAssignment.kind === 'repository' ? [savedAssignment.repositoryDirectory]
      : await this.files.readWorkspaceRepositories(savedAssignment.workspaceId, signal);
    // 保存済み assignment は探索候補であり、現在の配送先を保証しない。
    for (const repository of repositories) {
      signal?.throwIfAborted();
      let inboxDirectory: string;
      try {
        if (!await this.routing.permits({ kind: 'repository', repositoryDirectory: repository }, saved.conversationId, signal)) continue;
        signal?.throwIfAborted();
        inboxDirectory = await this.files.inboxDirectory(repository);
      } catch (error) { if (hasCode(error, 'ENOENT')) continue; throw error; }
      signal?.throwIfAborted();
      const expected = `standalone-answer-${createHash('sha256').update(JSON.stringify([inboxDirectory, answer.questionId])).digest('hex')}`;
      // 旧 inbox の createdAt は回答日時とは別に採番される。
      if (saved.eventId === expected) return { ...saved, event: { ...saved.event, inquiryAnswer: answer } };
    }
    return saved;
  }

  private path(eventId: string): string { return join(this.directory, `${fileKey(eventId)}.json`); }

  private index(record: EventRecord, path: string): void {
    const { event } = record;
    const request = requestKey(event);
    const previous = this.requests.get(request);
    const sequence = this.sequences.get(event.acceptedSequence);
    if (previous !== undefined && previous !== path || sequence !== undefined && sequence !== event.eventId) throw new Error('Conflicting stored event index');
    this.ids.set(event.eventId, path);
    this.requests.set(request, path);
    this.sequences.set(event.acceptedSequence, event.eventId);
    let conversation = this.byConversation.get(event.conversationId);
    if (conversation === undefined) {
      conversation = new Map<string, string>();
      this.byConversation.set(event.conversationId, conversation);
    }
    conversation.set(event.eventId, path);
    this.lastSequence = Math.max(this.lastSequence, event.acceptedSequence);
    this.knownFiles.add(path);
  }

  readTurns(conversationId: string): ReturnType<ConversationTurns['readTurns']> {
    return this.exclusive(async () => {
      await this.refresh();
      const turns: Awaited<ReturnType<ConversationTurns['readTurns']>>[number][] = [];
      // Completed turns and background-turn order must survive missed live
      // delivery. Read the durable events of this conversation through the
      // index that refresh() and accept() maintain, instead of reading every
      // event file in the shared directory on every call.
      const paths = this.byConversation.get(conversationId);
      if (paths === undefined) return turns;
      for (const path of paths.values()) {
        const record = await this.read(path);
        const { event } = record;
        const message = event.event.kind === 'human_command' && event.event.command.kind === 'message'
          && event.event.command.display !== false ? event.event.command.text : undefined;
        turns.push({ operationId: event.operationId, ...(message === undefined ? {} : { message }),
          acceptedSequence: event.acceptedSequence, pending: record.state === 'queued',
          ...(record.state === 'settled' ? { outcome: record.result.outcome } : {}) });
      }
      return turns.sort((left, right) => left.acceptedSequence - right.acceptedSequence);
    });
  }

  private async refresh(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    const present = new Set<string>();
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      present.add(join(this.directory, entry.name));
    }
    // A file another instance indexed can disappear afterwards (the
    // rollback in accept() unlinks after releasing the lock). Drop index
    // entries whose file is gone before registering new files: a new
    // event may reuse the vanished event's sequence or request key, and
    // registering it against the stale entry would throw a conflict.
    for (const path of this.knownFiles) {
      if (!present.has(path)) this.forget(path);
    }
    for (const path of present) {
      if (!this.knownFiles.has(path)) {
        const record = await this.read(path);
        this.index(record, path);
      }
    }
  }

  private forget(path: string): void {
    this.knownFiles.delete(path);
    const removedIds = new Set<string>();
    for (const [eventId, candidate] of this.ids) {
      if (candidate === path) {
        this.ids.delete(eventId);
        removedIds.add(eventId);
      }
    }
    for (const [request, candidate] of this.requests) {
      if (candidate === path) this.requests.delete(request);
    }
    if (removedIds.size === 0) return;
    for (const [sequence, eventId] of this.sequences) {
      if (removedIds.has(eventId)) this.sequences.delete(sequence);
    }
    for (const [conversationId, conversation] of this.byConversation) {
      for (const eventId of removedIds) conversation.delete(eventId);
      if (conversation.size === 0) this.byConversation.delete(conversationId);
    }
  }

  private async write(record: EventRecord): Promise<void> {
    await writePrivateFile(this.path(record.event.eventId), JSON.stringify(EventRecordWriteSchema.parse(record)));
  }

  async accept(input: AcceptedEvent): ReturnType<EventStore['accept']> {
    // 呼出し元が await 中に変更しても、受付内容は変えない。
    const event = AcceptedEventSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    return this.serializeHistory(async () => {
      let writing = false;
      try {
        return await this.exclusive(async () => {
          await this.refresh();
          const path = this.ids.get(event.eventId) ?? this.requests.get(requestKey(event));
          if (path !== undefined) {
            const stored = await this.read(path);
            // 廃止した待機・実行中イベントを duplicate 経由で再びキューへ戻さない。
            const state = isRetiredWatchEvent(stored.event) && stored.state !== 'settling' ? 'settled' : stored.state;
            return { kind: 'duplicate', event: stored.event, state };
          }
          const record: EventRecord = { state: 'queued', event };
          const sequence = this.sequences.get(event.acceptedSequence);
          if (sequence !== undefined) throw new Error('Accepted sequence is already stored');
          writing = true;
          await this.write(record);
          this.index(record, this.path(event.eventId));
          return { kind: 'stored' };
        });
      } catch (error) {
        if (writing) {
          // 保存後の応答・ロック解放の失敗でも、拒否した発言を復元させない。
          await unlink(this.path(event.eventId)).catch((cleanup: unknown) => { if (!hasCode(cleanup, 'ENOENT')) throw cleanup; });
          this.ids.delete(event.eventId);
          this.requests.delete(requestKey(event));
          this.sequences.delete(event.acceptedSequence);
          this.byConversation.get(event.conversationId)?.delete(event.eventId);
          this.knownFiles.delete(this.path(event.eventId));
        }
        throw error;
      }
    });
  }

  private assertTurn(event: AcceptedEvent, turn: TurnIdentity): void {
    StoredTurnSchema.parse({ conversationId: turn.conversationId, operationId: turn.operationId, generation: turn.generation });
    if (event.conversationId !== turn.conversationId || event.operationId !== turn.operationId) throw new Error('Turn does not match stored event');
  }

  private assertResult(event: AcceptedEvent, result: TurnResult): void {
    this.assertTurn(event, result);
    if (!isDeepStrictEqual(event, result.event)) throw new Error('Result does not match stored event');
  }

  async markStarted(eventId: string, turn: TurnIdentity): Promise<void> {
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      this.assertTurn(record.event, turn);
      if (record.state !== 'queued') {
        const stored = record.state === 'running' ? record.turn : record.result;
        if (stored.generation !== turn.generation) throw new Error('Conflicting started turn');
        return;
      }
      await this.write({ state: 'running', event: record.event, turn: { conversationId: turn.conversationId, operationId: turn.operationId, generation: turn.generation } });
    });
  }

  async saveResult(eventId: string, input: TurnResult): Promise<void> {
    const result = TurnResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      this.assertResult(record.event, result);
      if (record.state === 'settling' || record.state === 'settled') {
        if (!isDeepStrictEqual(record.result, result)) throw new Error('Conflicting stored result');
        return;
      }
      if (record.state !== 'running' || record.turn.generation !== result.generation) throw new Error('Result has no matching running turn');
      await this.write({ state: 'settling', event: record.event, result });
    });
  }

  async markSettled(eventId: string, input: TurnResult): Promise<void> {
    const result = TurnResultSchema.parse(JSON.parse(JSON.stringify(input)) as unknown);
    await this.exclusive(async () => {
      const record = await this.read(this.path(eventId));
      if (result.outcome.kind === 'deferred' && record.state === 'queued' && isDeepStrictEqual(record.event, result.event)) return;
      if (record.state !== 'settling' && record.state !== 'settled' || !isDeepStrictEqual(record.result, result)) throw new Error('Result was not saved before settlement');
      if (record.state === 'settling') await this.write(result.outcome.kind === 'deferred'
        ? { state: 'queued', event: record.event } : { ...record, state: 'settled' });
    });
  }

  async restore(): ReturnType<EventStore['restore']> {
    return this.exclusive(async () => {
      await this.refresh();
      return { lastAcceptedSequence: this.lastSequence, pending: this.pending() };
    });
  }

  async hasGoalRegistration(repositoryDirectory: string, goalId: string): Promise<boolean> {
    await ensurePrivateDirectory(this.directory);
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const record = await this.read(join(this.directory, entry.name));
      const { event } = record.event;
      if (event.kind === 'goal_registered' && event.repositoryDirectory === repositoryDirectory && event.goalId === goalId) return true;
    }
    return false;
  }

  async recentMessages(target: string, limit: number, signal?: AbortSignal): Promise<RecentMessages> {
    RecentMessageLimitSchema.parse(limit);
    return this.serializeHistory(async () => {
      await ensurePrivateDirectory(this.directory);
      signal?.throwIfAborted();
      const recent: Array<{ message: RecentMessage; part: number }> = [];
      let truncated = false;
      const append = (message: Omit<RecentMessage, 'truncated'>, part: number): void => {
        const text = truncateUtf8(message.text, RECENT_HISTORY_TEXT_BYTES);
        recent.push({ message: { ...message, text: text.value, truncated: text.bytes < Buffer.byteLength(message.text) }, part });
        recent.sort((a, b) => a.message.acceptedSequence - b.message.acceptedSequence || a.part - b.part);
        if (recent.length > limit) { recent.shift(); truncated = true; }
      };
      for await (const entry of await opendir(this.directory)) {
        signal?.throwIfAborted();
        if (!entry.name.endsWith('.json')) continue;
        const record = await this.read(join(this.directory, entry.name), signal);
        const saved = record.event;
        const event = saved.event;
        const direct = saved.conversationId === target;
        const relay = event.kind === 'director_message' && event.directorConversationId === target
          && target === conversationId({ kind: 'daemon' });
        if (!direct && !relay) continue;
        const humanMessage = event.kind === 'human_command' && event.command.kind === 'message' ? event.command : undefined;
        const directorMessage = event.kind === 'director_message' && event.inquiryAnswer === undefined;
        if (humanMessage === undefined && !directorMessage && !relay) continue;
        const outcome = record.state === 'settled' ? record.result.outcome : undefined;
        const status = outcome?.kind === 'failed' || outcome?.kind === 'interrupted' ? outcome.kind
          : outcome?.kind === 'completed' ? (outcome.result.kind === 'error' ? 'failed' : 'completed') : 'accepted';
        const identity = { conversationId: target, operationId: saved.operationId, acceptedSequence: saved.acceptedSequence };
        if (direct && humanMessage !== undefined && humanMessage.display !== false) {
          append({ ...identity, kind: 'message', status, speaker: 'human', text: humanMessage.text }, 0);
        } else if (direct && directorMessage && !(saved.source === 'director'
          && saved.eventId === `legacy-running-${saved.operationId}` && saved.requestId === saved.eventId)) {
          append({ ...identity, kind: 'message', status, speaker: event.origin === undefined ? 'unknown' : event.origin,
            text: event.text, directorConversationId: event.directorConversationId,
            ...(event.origin === undefined ? {} : { origin: event.origin }) }, 0);
        }
        // settled は apply（director への結果通知保存を含む）が完了した後にだけ保存される。
        if (outcome?.kind === 'completed' && outcome.result.kind === 'reply') {
          append({ ...identity, kind: 'reply', status: 'completed', text: outcome.result.message,
            speaker: saved.conversationId === conversationId({ kind: 'daemon' }) ? 'director' : 'manager',
            ...(relay ? { senderConversationId: saved.conversationId, directorConversationId: event.directorConversationId,
              ...(event.origin === undefined ? {} : { origin: event.origin }) } : {}) }, 1);
        } else if (relay && outcome !== undefined && outcome.kind !== 'deferred') {
          const failure = outcome.kind === 'failed' ? outcome.message
            : outcome.kind === 'interrupted' ? (outcome.message ?? 'Manager turn interrupted')
              : outcome.result.kind === 'error' ? outcome.result.message : undefined;
          if (failure !== undefined) append({ ...identity, kind: 'result', status, text: failure,
            speaker: 'manager', senderConversationId: saved.conversationId, directorConversationId: event.directorConversationId,
            ...(event.origin === undefined ? {} : { origin: event.origin }) }, 1);
        }
      }
      signal?.throwIfAborted();
      const messages = recent.map(({ message }) => message);
      while (Buffer.byteLength(JSON.stringify({ messages, truncated })) > RECENT_MESSAGES_MAX_BYTES) {
        messages.shift(); truncated = true;
      }
      return { messages, truncated: truncated || messages.some((message) => message.truncated) };
    }, signal);
  }

  private async *pending(): AsyncGenerator<StoredEvent> {
    for await (const entry of await opendir(this.directory)) {
      if (!entry.name.endsWith('.json')) continue;
      const record = await this.read(join(this.directory, entry.name));
      if (isRetiredWatchEvent(record.event) && record.state !== 'settling') continue;
      if (record.state === 'settling') yield { ...record, state: 'settling' };
      else if (record.state === 'queued') yield { state: 'queued', event: record.event };
      else if (record.state === 'running') yield { state: 'running', event: record.event, turn: record.turn };
    }
  }
}
