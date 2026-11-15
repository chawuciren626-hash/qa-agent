// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import * as React from 'react';
import { click, mount, settle, unmountAll, waitFor } from './helpers/dom';
import { createWorkspaceUI } from '../../../../penguin/ui/workspace-ui.mjs';

afterEach(async () => { await unmountAll(); vi.restoreAllMocks(); });

async function openArtifacts() {
  const request = vi.fn(async (url: string) => {
    if (url.includes('/memory/library')) return { entries: [] };
    const path = new URL(url, 'http://localhost').searchParams.get('path');
    const entries = path === '' ? [{ name: 'reports', kind: 'dir' }]
      : path === 'reports' ? [{ name: 'nested', kind: 'dir' }]
      : [{ name: 'slow.txt', kind: 'file', sizeBytes: 12 }, { name: 'new.txt', kind: 'file', sizeBytes: 8 }, { name: 'data.bin', kind: 'file', sizeBytes: 4 }];
    return { entries };
  });
  const ui = createWorkspaceUI({
    React, useProject: () => ({ currentProject: { projectId: 'fixture' }, agents: [] }),
    useAuth: () => ({ user: { userId: 'fixture' } }),
    useSessions: () => ({ sessions: [{ sessionId: 'task', title: 'Synthetic task', workspace: '/fixture' }] }),
    useLocation: () => ({ search: '?section=artifacts' }), useNavigate: () => vi.fn(),
    request, Modal: () => null, notify: vi.fn(),
  });
  const mounted = await mount(React.createElement(ui.SectionPage, { view: 'library' }));
  await waitFor(() => !!document.querySelector('.qa-art'));
  return { request, mounted };
}
const treeButton = (title: string) => document.querySelector<HTMLButtonElement>(`.qa-art-tree-card button[title="${title}"]`)!;
async function expandToFiles() {
  await click(treeButton('任务_Synthetic task'));
  await waitFor(() => !!treeButton('reports'));
  await click(treeButton('reports'));
  await waitFor(() => !!treeButton('nested'));
  await click(treeButton('nested'));
  await waitFor(() => !!treeButton('slow.txt'));
}

it('opens with no selection and expands nested directories using their full paths', async () => {
  const { request } = await openArtifacts();
  expect(document.body.textContent).toContain('从左侧目录树选择一个文件或目录查看详情');
  await expandToFiles();
  expect(request.mock.calls.map(([url]) => url)).toContain('/api/sessions/task/files?path=reports%2Fnested');
  expect(document.querySelector('.qa-art-crumbs')?.textContent).toContain('reports›nested');
  await click(treeButton('nested'));
  expect(treeButton('slow.txt')).toBeNull();
});

it('opens directories from the detail list as well as the tree', async () => {
  await openArtifacts();
  await click(treeButton('任务_Synthetic task'));
  await waitFor(() => !!document.querySelector('.qa-art-detail button[title="reports"]'));
  await click(document.querySelector('.qa-art-detail button[title="reports"]')!);
  await waitFor(() => !!document.querySelector('.qa-art-detail button[title="nested"]'));
  expect(document.querySelector('.qa-art-crumbs')?.textContent).toContain('reports');
});

it.each(['data.bin', 'new.txt'])('discards a late preview after selecting %s', async (next) => {
  let finish!: (value: Response) => void;
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    if (url.includes('slow.txt')) {
      signal = init.signal!;
      return new Promise<Response>(resolve => { finish = resolve; });
    }
    return Promise.resolve(new Response('NEW CONTENT'));
  }));
  await openArtifacts();
  await expandToFiles();
  await click(treeButton('slow.txt'));
  await click(treeButton(next));
  expect(signal.aborted).toBe(true);
  await React.act(async () => { finish(new Response('STALE CONTENT')); });
  await settle();
  expect(document.querySelector('.qa-art-detail')?.textContent).not.toContain('STALE CONTENT');
  if (next === 'new.txt') expect(document.querySelector('.qa-art-preview')?.textContent).toBe('NEW CONTENT');
  else expect(document.querySelector('.qa-art-preview')).toBeNull();
});

it('cancels a pending preview when leaving the browser', async () => {
  let signal!: AbortSignal;
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => { signal = init.signal!; return new Promise(() => {}); }));
  const { mounted } = await openArtifacts();
  await expandToFiles();
  await click(treeButton('slow.txt'));
  await mounted.unmount();
  expect(signal.aborted).toBe(true);
});
