import { validateCountMetadata } from './execution-counts.mjs';
const valid = (condition, message) => { if (!condition) throw new Error(message); };

export function validateResponseCheck(check) {
  valid(check && typeof check === 'object' && !Array.isArray(check), 'response_check must be an object');
  valid(Object.keys(check).every(key=>['url','method','http_status','field','equals','source_path','quote','case_id','title','expected','case_ref'].includes(key)), 'Unknown response_check field');
  validateCountMetadata(check);
  const url=new URL(check.url);
  valid(['http:','https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Use an exact supplied/observed endpoint without credentials, query or fragment');
  valid(['GET','POST','PUT','PATCH','DELETE'].includes(check.method), 'Explicit response method required');
  valid(Number.isInteger(check.http_status) && check.http_status>=100 && check.http_status<=599, 'Explicit expected HTTP status required');
  valid(typeof check.field==='string' && /^(?:[A-Za-z][A-Za-z0-9_]*\.)*(?:code|status|success)$/.test(check.field) && check.field.length<=100 && !/password|secret|token|credential|cookie|authorization|__proto__|prototype|constructor/i.test(check.field), 'Only a business code/status/success field may be compared');
  valid(['string','number','boolean'].includes(typeof check.equals) && (typeof check.equals!=='string' || check.equals.length<=100) && (typeof check.equals!=='number' || Number.isFinite(check.equals)), 'Expected business value must be a bounded scalar');
  valid(typeof check.source_path==='string' && /^inputs\/(?!.*(?:\.\.|\\|:))[^\x00-\x1f]+$/.test(check.source_path) && typeof check.quote==='string' && check.quote.trim(), 'Current input source and verbatim contract quote required');
  valid(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(check.case_id ?? '') && typeof check.title==='string' && check.title.trim() && typeof check.expected==='string' && check.expected.trim(), 'Response assertion identity required');
}

export function compareBusinessResponse(check, httpStatus, data) {
  let value=data;
  for(const key of check.field.split('.')) {
    if(!value || typeof value!=='object' || !Object.hasOwn(value,key)) return {status:'blocked',reason:'business_field_missing',http_status:httpStatus};
    value=value[key];
  }
  if(!['string','number','boolean'].includes(typeof value)) return {status:'blocked',reason:'business_field_not_scalar',http_status:httpStatus};
  const httpMatched=httpStatus===check.http_status, businessMatched=value===check.equals;
  // Never return the body or business field value; either may contain credentials.
  return {status:httpMatched && businessMatched?'passed':'failed',http_status:httpStatus,http_matched:httpMatched,business_matched:businessMatched};
}

// Passive observation only: no HTTP calls, route rewrites or operation retries.
export function observeBusinessResponse(page, check, timeout=5000) {
  const requests=new Set();let active=true, responses=0, detail, resolveFirst;
  const first=new Promise(resolve=>{resolveFirst=resolve;});
  const matches=req=>req.url()===new URL(check.url).href && req.method()===check.method;
  const onRequest=req=>{try {if(active && matches(req) && req.frame()===page.mainFrame()) requests.add(req);} catch { /* Requests without a trusted frame are not evidence. */ }};
  const onResponse=async response=>{
    if(!active || !requests.has(response.request())) return;
    responses++;
    try {
      const headers=response.headers(),length=Number(headers['content-length']);
      if(!/application\/(?:[\w.+-]*\+)?json/i.test(headers['content-type'] ?? '') || !Number.isInteger(length) || length<1 || length>65536) detail={status:'blocked',reason:'json_body_unavailable_or_size_unknown'};
      else {
        const body=await response.body();
        detail=body.length>65536?{status:'blocked',reason:'body_too_large'}:compareBusinessResponse(check,response.status(),JSON.parse(body.toString('utf8')));
      }
    } catch {detail={status:'blocked',reason:'response_body_unavailable'};}
    resolveFirst();
  };
  page.on('request',onRequest);page.on('response',onResponse);
  let timer;
  const deadline=new Promise(resolve=>{timer=setTimeout(resolve,timeout);});
  const close=()=>{active=false;clearTimeout(timer);page.off('request',onRequest);page.off('response',onResponse);};
  return {cancel:close,async finish(){
    await Promise.race([first,deadline]);close();
    if(requests.size!==1 || responses!==1) return {status:'blocked',reason:requests.size>1 || responses>1?'ambiguous_matching_requests':'no_completed_matching_response'};
    return detail ?? {status:'blocked',reason:'response_body_unavailable'};
  }};
}
