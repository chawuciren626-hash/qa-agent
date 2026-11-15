// @vitest-environment jsdom
import { createElement as h } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { InstalledSkillFiles } from '../src/features/skills/installed-skill-files';
import { mount, click, waitFor, unmountAll } from './helpers/dom';
import * as api from '../src/api/endpoints';
vi.mock('../src/api/endpoints', () => ({getAgentSkillFiles:vi.fn()}));
afterEach(async()=>{await unmountAll();vi.resetAllMocks();});
it('opens SKILL.md, follows a reference and resets content when changing installed sources',async()=>{
  const read=vi.mocked(api.getAgentSkillFiles);
  read.mockResolvedValueOnce({files:{'SKILL.md':'---\nname: demo\n---\n# First copy\n\n[Read reference](references/guide.md)','references/guide.md':'# Reference content'}});
  const props={projectId:'project',agentId:'first',name:'demo',machineId:null};
  const view=await mount(h(InstalledSkillFiles,props));
  await waitFor(()=>document.body.textContent?.includes('First copy')===true);
  expect(read).toHaveBeenCalledWith('project','first','demo',null);
  await click([...document.querySelectorAll('a')].find(a=>a.textContent==='Read reference')!);
  expect(document.body.textContent).toContain('Reference content');
  let resolve!: (v:{files:Record<string,string>})=>void;
  read.mockReturnValueOnce(new Promise(r=>{resolve=r;}));
  await view.rerender(h(InstalledSkillFiles,{...props,agentId:'second'}));
  expect(document.body.textContent).not.toContain('Reference content');
  resolve({files:{'SKILL.md':'# Second copy'}});
  await waitFor(()=>document.body.textContent?.includes('Second copy')===true);
});
