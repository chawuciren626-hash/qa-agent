/** Authenticated local probe. It reports no cookies, prompt contents, memory, or credentials. */
import { resolve } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { attachLocalService } from './local-service.mjs';
import { loadProductLayout } from './product-layout.mjs';

export async function probeInstalledSharedAgent(installation) {
  const client = await attachLocalService(installation);
  try {
    const layout = loadProductLayout(installation);
    const token = readFileSync(resolve(layout.paths.host_data, 'api-token'), 'utf8').trim();
    if (!token) throw Error('Local API token is empty');
    const read = async (path) => {
      const response = await fetch(client.origin + path, { headers: { authorization: `Bearer ${token}` }, redirect: 'manual' });
      if (!response.ok) throw Error(`Shared Agent probe failed: ${path} ${response.status}`);
      return response.json();
    };
    const projects = [];
    for (const projectId of ['default_project', 'debugging']) {
      const role = await read(`/api/projects/${projectId}/agents/test_agent/config`);
      const skills = await read(`/api/projects/${projectId}/agents/test_agent/skills`);
      if (!role.managed || !Array.isArray(skills.skills)) throw Error(`Shared role view incomplete: ${projectId}`);
      let legacyReadable = false;
      const agentsRoot = resolve(layout.paths.host_data, projectId, 'agents');
      for (const agentId of readdirSync(agentsRoot)) {
        const markerFile = resolve(agentsRoot, agentId, 'agent_state', 'shared-agent.json');
        let marker;
        try { marker = JSON.parse(readFileSync(markerFile, 'utf8')); } catch { continue; }
        const sessionId = marker.legacySessionIds?.[0];
        if (!sessionId) continue;
        const historical = await read(`/api/sessions/${sessionId}`);
        const messages = await read(`/api/sessions/${sessionId}/messages`);
        if (historical.session?.projectId !== projectId || !Array.isArray(messages.messages))
          throw Error(`Historical Session view incomplete: ${projectId}`);
        legacyReadable = true;
        break;
      }
      if (!legacyReadable) throw Error(`No readable historical Session: ${projectId}`);
      projects.push({ projectId, testAgentVersion: role.managed.version,
        testAgentSkillCount: skills.skills.length, localOverrideCount: role.managed.localSkillOverrides.length,
        legacyReadable });
    }
    const fallback = await read('/api/projects/default_project/agents/default_agent/config');
    if (!fallback.managed?.plugins?.includes('goal')) throw Error('Default Agent lacks published Goal adapter');
    const published = await read('/api/projects/default_project/agents/requirement_analysis_agent/skills');
    if (!published.skills.some(skill => skill.name === 'requirement-analysis'))
      throw Error('Published requirement Skill is absent');
    const files = await read('/api/projects/default_project/agents/requirement_analysis_agent/skills/requirement-analysis/files');
    if (!files.files?.['SKILL.md']) throw Error('Published requirement Skill source is absent');
    return { status: 'passed', projects, defaultAgentVersion: fallback.managed.version,
      defaultAgentPluginCount: fallback.managed.plugins.length, publishedSkillReadable: true };
  } finally { client.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const installation = process.argv[2];
  if (!installation) throw Error('Usage: probe-installed-shared-agent.mjs <installation.json>');
  console.log(JSON.stringify(await probeInstalledSharedAgent(resolve(installation))));
}
