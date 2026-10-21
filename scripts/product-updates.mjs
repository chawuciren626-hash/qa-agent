import {readFileSync} from 'node:fs';

export const releaseEndpoint='https://api.github.com/repos/Prism-Shadow/penguin-harness/releases/latest';
const stable=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function loadHostPolicy() {
  const p=JSON.parse(readFileSync(new URL('../config/host-compatibility.json',import.meta.url),'utf8'));
  if(p.version!==1 || p.release_api!==releaseEndpoint || !p.hosts || typeof p.hosts!=='object') throw new Error('Invalid host compatibility policy');
  return p;
}
export function hostCompatibility(version,policy=loadHostPolicy(),platform=`${process.platform}-${process.arch}`) {
  const host=policy.hosts[version];
  return host?.status==='supported' && host.platforms.includes(platform)?{status:'supported',version,adapter_version:policy.adapter_version,distribution_ready:host.distribution_ready}:
    {status:'unverified',version,reason:host?'unsupported_platform':'uninspected_host_version'};
}
export function classifyHostRelease(release,installed,policy=loadHostPolicy(),platform=`${process.platform}-${process.arch}`) {
  const version=typeof release.tag_name==='string'?release.tag_name.replace(/^v/,''):'';
  if(!stable.test(version) || !stable.test(installed) || release.draft!==false || release.prerelease!==false || release.html_url!==`https://github.com/Prism-Shadow/penguin-harness/releases/tag/v${version}`) throw new Error('Invalid stable release metadata');
  const a=version.split('.').map(BigInt),b=installed.split('.').map(BigInt);
  const index=a.findIndex((v,i)=>v!==b[i]);
  const newer=index>=0 && a[index]>b[index];
  const compatibility=hostCompatibility(version,policy,platform);
  return {status:!newer?'no_newer_release':compatibility.status==='supported'?'compatible_update_available':'compatibility_review_required',
    installed_version:installed,latest_version:version,release_url:release.html_url,compatibility,
    automatic_install:false,distribution_ready:compatibility.distribution_ready===true};
}
export async function checkHostUpdate(installed,{fetcher=fetch,policy=loadHostPolicy(),platform=`${process.platform}-${process.arch}`}={}) {
  const checked_at=new Date().toISOString();
  try {
    const response=await fetcher(releaseEndpoint,{headers:{accept:'application/vnd.github+json','user-agent':'AITestHarness-compatibility-check'},redirect:'error',signal:AbortSignal.timeout(8000)});
    if(!response.ok) return {status:'check_failed',reason:response.status===403||response.status===429?'rate_limited':'upstream_http_error',http_status:response.status,checked_at,automatic_install:false};
    // Bounded streaming read: never accept an unbounded upstream response as a cache record.
    const reader=response.body?.getReader();if(!reader) throw new Error('Missing response body');
    let length=0;const chunks=[];
    try {for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>1024*1024)throw new Error('Oversized response');chunks.push(Buffer.from(value));}}
    finally {await reader.cancel().catch(()=>{});}
    const release=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return {...classifyHostRelease(release,installed,policy,platform),checked_at,source:releaseEndpoint};
  } catch {return {status:'check_failed',reason:'network_or_invalid_metadata',checked_at,automatic_install:false};}
}
