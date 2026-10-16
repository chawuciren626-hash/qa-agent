import { validateResponseCheck, compareBusinessResponse } from './browser-response-check.mjs';
const requireValue=(ok,message)=>{if(!ok) throw new Error(message);};

export function validateApiCheck(check) {
  requireValue(check && ['GET','HEAD'].includes(check.method),'Only scoped GET/HEAD checks are supported; no automatic writes or retries');
  requireValue(check.method!=='HEAD' || check.field===undefined,'HEAD checks status only');
  requireValue(check.field!==undefined || check.equals===undefined,'Business expectation needs an explicit field');
  validateResponseCheck({...check,method:'GET',...(check.field===undefined?{field:'code',equals:0}:{})});
}

export function validateFault(fault) {
  requireValue(fault && Object.keys(fault).every(k=>['url','method','mode','http_status','source_path','quote'].includes(k)),'Invalid fault fields');
  requireValue(fault.method==='GET' && ['abort','http_error'].includes(fault.mode),'Faults support exact GET abort or synthetic HTTP error only');
  requireValue(fault.mode==='abort'?fault.http_status===undefined:[500,502,503,504].includes(fault.http_status),'Explicit supported simulated status required');
  validateResponseCheck({url:fault.url,method:'GET',http_status:200,field:'code',equals:0,source_path:fault.source_path,quote:fault.quote,case_id:'fault',title:'Fault',expected:'Explicitly requested simulation'});
}

export async function runReadOnlyApiCheck(page,check) {
  // Response bytes stay transient; only bounded comparisons leave this helper.
  let response;
  try {response=await page.evaluate(async ({url,method,needsBody})=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
    try {
      const result=await fetch(url,{method,credentials:'same-origin',redirect:'error',cache:'no-store',signal:controller.signal});
      if(!needsBody) {await result.body?.cancel();return {http_status:result.status};}
      if(!/application\/(?:[\w.+-]*\+)?json/i.test(result.headers.get('content-type') ?? '')) {await result.body?.cancel();return {http_status:result.status,unavailable:true};}
      const reader=result.body?.getReader();if(!reader) return {http_status:result.status,unavailable:true};
      let length=0,text='';const decoder=new TextDecoder();
      for(;;) {const part=await reader.read();if(part.done) break;length+=part.value.byteLength;if(length>65536) {await reader.cancel();return {http_status:result.status,unavailable:true};}text+=decoder.decode(part.value,{stream:true});}
      return {http_status:result.status,text:text+decoder.decode()};
    } catch {return {unavailable:true};}
    finally {clearTimeout(timer);controller.abort();}
  },{url:check.url,method:check.method,needsBody:check.field!==undefined});}
  catch {return {status:'blocked',reason:'api_transport_or_page_unavailable'};}
  if(response.unavailable) return {status:'blocked',reason:'api_response_unavailable_or_unsupported',...(response.http_status?{http_status:response.http_status}:{})};
  if(check.field===undefined) return {status:response.http_status===check.http_status?'passed':'failed',http_status:response.http_status,http_matched:response.http_status===check.http_status};
  try {return compareBusinessResponse(check,response.http_status,JSON.parse(response.text));}
  catch {return {status:'blocked',reason:'api_json_unavailable',http_status:response.http_status};}
}

export function createOneShotFault(fault) {
  let active=true,hits=0,applied=false,settled=false,settle;
  const completed=new Promise(resolve=>{settle=resolve;});
  return {
    async intercept(route,page) {
      const req=route.request();
      if(!active || hits || req.url()!==new URL(fault.url).href || req.method()!=='GET' || !['xhr','fetch'].includes(req.resourceType())) return false;
      try {if(req.frame()!==page.mainFrame()) return false;} catch {return false;}
      hits++;
      try {
        if(fault.mode==='abort') await route.abort('failed');
        else await route.fulfill({status:fault.http_status,contentType:'application/json',body:'{"qa_simulated_failure":true}'});
        applied=true;
      } catch { /* A failed injection is inconclusive, never a real service failure. */ }
      finally {settled=true;settle();}
      return true;
    },
    async finish(wait=true) {
      let timer;
      try {if(wait && !applied) await Promise.race([completed,new Promise(resolve=>{timer=setTimeout(resolve,2500);})]);}
      finally {clearTimeout(timer);active=false;}
      return {mode:fault.mode,...(fault.mode==='http_error'?{http_status:fault.http_status}:{}),matched_requests:hits,applied,in_flight:hits>0 && !settled,disabled:true,
        interpretation:'Synthetic browser-side fault, at most one matching GET in the action window; temporal association is not causal proof. No real backend-failure claim.'};
    }
  };
}
