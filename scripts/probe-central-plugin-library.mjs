import { loadPluginGroups, libraryPlugin, libraryPluginReadme } from '../accounts-source/platform/packages/core/dist/index.js';
const groups = loadPluginGroups();
const sample = libraryPlugin('ace-rsi-toolkit');
console.log(JSON.stringify({plugins: groups.reduce((sum, group) => sum + group.plugins.length, 0), sample: sample?.name, skills: sample?.skills.length, icon: !!sample?.icon, readme: !!libraryPluginReadme('ace-rsi-toolkit')}));
