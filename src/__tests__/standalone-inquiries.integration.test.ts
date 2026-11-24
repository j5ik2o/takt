import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { listTaktStandaloneInquiries } from '../features/mcp/standaloneInquiryOperations.js';
import { projectIdForCanonicalDirectory } from '../infra/config/global/projectRegistry.js';
import { collectSkippedInquiryFiles } from '../infra/goals/inquiry-files.js';
import { listPendingInquiries } from '../infra/goals/pending-inquiries.js';
import { StandaloneInquiryStore, type InquiryOwner } from '../infra/goals/standalone-inquiries.js';
import { firstTextContent } from './helpers/mcp-content.js';

it.each(['workspace', 'repository'] as const)('keeps normal questions and their answers within their %s owner', async (kind) => {
  const directory = process.env.TAKT_CONFIG_DIR!;
  const owners: InquiryOwner[] = [];
  for (const [index, name] of ['first', 'second'].entries()) {
    if (kind === 'workspace') {
      const workspaceId = `750e8400-e29b-41d4-a716-44665544000${index + 1}`;
      const path = join(directory, 'workspaces', workspaceId);
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'workspace.json'), JSON.stringify({ id: workspaceId, name, repositoryDirectories: [] }));
      owners.push({ kind, workspaceId });
    } else {
      const repositoryDirectory = join(directory, name);
      await mkdir(repositoryDirectory, { recursive: true });
      owners.push({ kind, repositoryDirectory });
    }
  }
  const first = new StandaloneInquiryStore(directory, owners[0]!);
  const second = new StandaloneInquiryStore(directory, owners[1]!);
  const question = await first.create({ body: 'Choose a destination', options: ['A', 'B'] });
  const other = await second.create({ body: 'Choose another destination' });
  expect(await first.listPending()).toEqual([question]);
  expect(await second.listPending()).toEqual([other]);
  const pending = await listPendingInquiries(directory, { ...owners[0]!, repositoryDirectories: [] });
  expect(pending.errors).toEqual([]);
  expect(pending.inquiries.map(({ question }) => question.id)).toEqual([question.id]);
  await first.answer(question.id, { text: 'A' }, 'slack');
  expect((await new StandaloneInquiryStore(directory, owners[0]!).get(question.id)).answer).toMatchObject({ text: 'A', source: 'slack' });
  expect(await second.listPending()).toEqual([other]);
  await expect(second.get(question.id)).rejects.toThrow();
});

it.each(['workspace', 'repository'] as const)('lists the readable inquiries of a %s owner whose directory holds invalid files and leaves those files unchanged', async (kind) => {
  const directory = process.env.TAKT_CONFIG_DIR!;
  let owner: InquiryOwner;
  if (kind === 'workspace') {
    owner = { kind, workspaceId: '750e8400-e29b-41d4-a716-446655440009' };
  } else {
    owner = { kind, repositoryDirectory: join(directory, 'skipped-repository') };
    await mkdir(owner.repositoryDirectory, { recursive: true });
  }
  const pending = await new StandaloneInquiryStore(directory, owner).create({ body: 'Choose a destination' });
  const inquiries = owner.kind === 'workspace' ? join(directory, 'workspaces', owner.workspaceId, 'inquiries')
    : join(directory, 'projects', projectIdForCanonicalDirectory(await realpath(owner.repositoryDirectory)), 'inquiries');
  // どちらも、v4 の UUID で作られる正常な 1 件より名前順で前に来る。
  const unanswered = join(inquiries, '00000000-0000-1000-8000-000000000001.json');
  const broken = join(inquiries, '00000000-0000-1000-8000-000000000002.json');
  const saved = new Map([
    [unanswered, JSON.stringify({ id: '00000000-0000-1000-8000-000000000001', body: 'unreadable-inquiry-body', recipient: 'human', status: 'answered' })],
    [broken, '{"body":"broken-inquiry-body"'],
  ]);
  for (const [path, content] of saved) await writeFile(path, content);
  const expected = [
    { path: unanswered, reason: 'answer: Only answered questions require an answer' },
    { path: broken, reason: 'invalid JSON' },
  ];
  const listed = async <T>(read: (store: StandaloneInquiryStore) => Promise<T>) => {
    const { reports, skipped } = collectSkippedInquiryFiles();
    const result = await read(new StandaloneInquiryStore(directory, owner, reports));
    expect(skipped.sort((left, right) => left.path.localeCompare(right.path))).toEqual(expected);
    return result;
  };

  expect(await listed((store) => store.list())).toEqual([pending]);
  expect(await listed((store) => store.listPending())).toEqual([pending]);
  expect(await listed(async (store) => {
    const questions = [];
    for await (const question of store.iteratePending()) questions.push(question);
    return questions;
  })).toEqual([pending]);
  expect(await listed((store) => store.listPendingPage(0, 50))).toEqual({ inquiries: [pending], totalCount: 1 });

  const manager = await listPendingInquiries(directory, { ...owner, repositoryDirectories: [] });
  expect(manager.inquiries.map(({ question }) => question.id)).toEqual([pending.id]);
  expect(manager.skippedInquiryFiles).toEqual(expected);

  const response = await listTaktStandaloneInquiries({ cwd: directory }, directory, owner);
  const text = firstTextContent(response.content);
  expect(response.isError).toBe(true);
  expect(JSON.parse(text)).toMatchObject({ inquiries: [{ id: pending.id }], totalCount: 1, skippedInquiryFiles: expected });
  expect(text).not.toContain('unreadable-inquiry-body');
  expect(text).not.toContain('broken-inquiry-body');

  // 既定の一覧（ログへ出す経路）も、読める 1 件を返す。
  expect(await new StandaloneInquiryStore(directory, owner).listPending()).toEqual([pending]);
  for (const [path, content] of saved) expect(await readFile(path, 'utf8')).toBe(content);
});

it('reports an unreadable inquiry file once across listings until the file changes', async () => {
  const directory = process.env.TAKT_CONFIG_DIR!;
  const owner: InquiryOwner = { kind: 'workspace', workspaceId: '750e8400-e29b-41d4-a716-446655440008' };
  const inquiries = join(directory, 'workspaces', owner.workspaceId, 'inquiries');
  await mkdir(inquiries, { recursive: true });
  const path = join(inquiries, '00000000-0000-1000-8000-000000000001.json');
  await writeFile(path, '{');
  const { reports, skipped } = collectSkippedInquiryFiles();
  const store = new StandaloneInquiryStore(directory, owner, reports);

  expect(await store.listPending()).toEqual([]);
  expect(await store.list()).toEqual([]);
  expect(skipped).toEqual([{ path, reason: 'invalid JSON' }]);
  await writeFile(path, '{"status":');
  expect(await store.listPendingPage(0, 1)).toEqual({ inquiries: [], totalCount: 0 });
  expect(skipped).toHaveLength(2);
  await rm(path);
  expect(await store.listPending()).toEqual([]);
  expect(skipped).toHaveLength(2);
});
