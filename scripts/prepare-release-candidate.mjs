// Prepare local review artifacts only. This command never creates tags or publishes releases.
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,existsSync,constants} from 'node:fs';
import {resolve,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertPlainPath,within} from './application-data.mjs';
import {verifyProductPayload,fileDigest} from './product-payload-check.mjs';
import {hostCompatibility} from './product-updates.mjs';

export const releaseChecks=['installer_payload_binding','fresh_install','desktop_bootstrap','installed_tools','installed_ui','host_contracts','upgrade_preservation','rollback_recovery','uninstall_retention','fresh_model_task','six_stage_task','clean_windows'];
export function assessReleaseEvidence(evidence,identity){
  if(evidence.version!==1||evidence.product_version!==identity.product_version||evidence.host_version!==identity.host_version||evidence.installer_sha256!==identity.installer_sha256||evidence.payload_manifest_sha256!==identity.payload_manifest_sha256)throw Error('Evidence does not match this installer and payload');
  if(!Array.isArray(evidence.checks))throw Error('Invalid acceptance evidence');
  const seen=new Set();
  for(const check of evidence.checks){
    if(!releaseChecks.includes(check.id)||seen.has(check.id)||!['passed','failed','pending'].includes(check.status))throw Error('Invalid or duplicate acceptance check');
    seen.add(check.id);
  }
  // Deliberately exclude arbitrary notes, local paths, logs and credentials from the public draft.
  const checks=releaseChecks.map(id=>({id,status:evidence.checks.find(c=>c.id===id)?.status??'pending'}));
  return {checks,blockers:checks.filter(c=>c.status!=='passed').map(c=>c.id),distribution_ready:false,publication:'not_published',review_required:true};
}
export function prepareReleaseCandidate({stage,installer,evidence,output}){
  stage=assertPlainPath(resolve(stage));installer=assertPlainPath(resolve(installer));evidence=assertPlainPath(resolve(evidence));output=assertPlainPath(resolve(output));
  if(existsSync(output)||[stage,installer,evidence].some(p=>within(output,p)||within(p,output)))throw Error('Use a fresh, separate release directory');
  const verified=verifyProductPayload(stage),manifestPath=resolve(stage,'product-payload.json');
  const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
  if(!/^\d+\.\d+\.\d+-preview\.\d+$/.test(manifest.product_version))throw Error('This workflow only prepares preview candidates');
  if(hostCompatibility(manifest.host_version,undefined,'win32-x64').status!=='supported')throw Error('Unverified host cannot enter a release candidate');
  const name=`AITestHarness-${manifest.product_version}-win-x64.exe`;
  if(basename(installer)!==name||readFileSync(installer).subarray(0,2).toString()!=='MZ')throw Error('Installer name or executable header mismatch');
  const identity={product_version:manifest.product_version,host_version:manifest.host_version,installer_sha256:fileDigest(installer),payload_manifest_sha256:fileDigest(manifestPath)};
  const review=assessReleaseEvidence(JSON.parse(readFileSync(evidence,'utf8').replace(/^\uFEFF/,'')),identity);
  mkdirSync(output,{recursive:true});
  copyFileSync(installer,resolve(output,name),constants.COPYFILE_EXCL);
  if(fileDigest(resolve(output,name))!==identity.installer_sha256)throw Error('Copied installer checksum mismatch');
  copyFileSync(manifestPath,resolve(output,'product-payload.json'),constants.COPYFILE_EXCL);
  copyFileSync(resolve(stage,'THIRD-PARTY-NOTICES.txt'),resolve(output,'THIRD-PARTY-NOTICES.txt'),constants.COPYFILE_EXCL);
  const report={version:1,...identity,...review,payload_check:verified,signature_status:manifest.signature_status??'unverified',created_at:new Date().toISOString()};
  writeFileSync(resolve(output,'acceptance.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  const notes=[`# AITestHarness ${manifest.product_version}`, '', '内部预览发行候选，尚未公开发布。', '',
    `Windows x64；内置 PenguinHarness ${manifest.host_version}、Node、Python、浏览器与八个测试角色初始化。`,
    '', '安装后从 AITestHarness 入口启动，按首页引导配置自己的模型账号、验证连接并填写示例任务。安装包不含模型额度。',
    '', '升级前退出应用并选择原完整安装目录。仅支持宿主版本和数据版本不变的升级；跨宿主升级及降级会拒绝。卸载默认保留用户数据。',
    '', `签名状态（载荷声明）：${report.signature_status}。尚未达到公开发行验收标准；完成检查后需维护者审核。`,
    '', '| 验收项 | 当前状态 |','| --- | --- |',...review.checks.map(c=>`| ${c.id} | ${c.status} |`),
    '', '安装前可用 PowerShell 校验下载文件：', '```powershell',`Get-FileHash -Algorithm SHA256 .\\${name}`,'```',
    `应与 SHA256SUMS.txt 中的值一致：${identity.installer_sha256}`, '',
    '此目录用于审核发行候选。源码提交、Actions 构建和候选目录生成均不会自动发布 GitHub Releases。',''].join('\n');
  writeFileSync(resolve(output,'RELEASE-NOTES.md'),notes,{flag:'wx'});
  const publishedFiles=[name,'product-payload.json','THIRD-PARTY-NOTICES.txt','acceptance.json','RELEASE-NOTES.md'];
  writeFileSync(resolve(output,'SHA256SUMS.txt'),publishedFiles.map(file=>`${fileDigest(resolve(output,file))}  ${file}`).join('\n')+'\n',{flag:'wx'});
  return {status:'draft_prepared',output,...identity,blockers:review.blockers,distribution_ready:false,publication:'not_published'};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
  if(process.argv.length!==6)throw Error('Usage: prepare-release-candidate.mjs <stage> <installer.exe> <evidence.json> <new-output-directory>');
  console.log(JSON.stringify(prepareReleaseCandidate({stage:process.argv[2],installer:process.argv[3],evidence:process.argv[4],output:process.argv[5]}),null,2));
}
