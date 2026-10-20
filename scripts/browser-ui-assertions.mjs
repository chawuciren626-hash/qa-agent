import { expect } from '@playwright/test';
import { uiComparison } from './browser-inputs.mjs';

export const uiConditions=['visible','hidden','text','value','count','readonly','editable','enabled','disabled'];
export const negativeUiCheck=check=>check.condition==='hidden' || (check.condition==='count' && check.value===0);

export async function expectUiCondition(target,check,timeout=5000) {
  const options={timeout};
  if(check.condition==='visible') await expect(target).toBeVisible(options);
  if(check.condition==='hidden') await expect(target).toBeHidden(options);
  if(check.condition==='text') {
    await expect(target).toBeVisible(options);
    if(uiComparison(check)==='exact_text') await expect.poll(()=>target.textContent(options),options).toBe(check.value ?? check.target.value);
    else await expect(target).toHaveText(check.value ?? check.target.value,options);
  }
  if(check.condition==='value') await expect(target).toHaveValue(check.value,options);
  if(check.condition==='count') await expect(target).toHaveCount(check.value,options);
  if(['readonly','editable','enabled','disabled'].includes(check.condition)) {
    await expect(target).toBeVisible(options);
    if(check.condition==='readonly') {
      // Disabled is not readonly. Restrict this assertion to controls with a
      // native readonly property; do not probe by attempting a write.
      await expect.poll(()=>target.evaluate(e=>e.matches('input,textarea') && e.readOnly===true,undefined,options),options).toBe(true);
    }
    if(check.condition==='editable') await expect(target).toBeEditable(options);
    if(check.condition==='enabled') await expect(target).toBeEnabled(options);
    if(check.condition==='disabled') await expect(target).toBeDisabled(options);
  }
}

export async function evaluateUiCheck(page,check,locator,{timeout=5000,getDocumentStatus=()=>null}={}) {
  const target=locator(check.target);
  let document,anchor;
  const blocked=reason=>({status:'blocked',reason});
  try {
    if(check.condition==='readonly' && await target.count()===1 && !await target.evaluate(e=>e.tagName==='TEXTAREA' || (e.tagName==='INPUT' && ['text','search','url','tel','email','password','date','month','week','time','datetime-local','number'].includes(e.type)),undefined,{timeout})) return blocked('unsupported_control');
    if(negativeUiCheck(check)) {
      if(getDocumentStatus()>=400) return blocked('error_document');
      if(!check.ready) return blocked('readiness_required');
      const region=locator(check.ready.target);
      try {
        if(await region.count()!==1) return blocked('readiness_not_unique');
        await expect(region).toBeVisible({timeout});
        await expect(region).toHaveText(check.ready.text,{timeout});
        anchor=await region.elementHandle();
        document=await page.evaluateHandle(()=>window.document);
      } catch {return blocked('business_region_not_ready');}
    }
    let failure;
    try {await expectUiCondition(target,check,timeout);}
    catch(error) {failure=error;}
    if(document) {
      if(getDocumentStatus()>=400) return blocked('error_document');
      try {
        const region=locator(check.ready.target);
        if(!await page.evaluate(previous=>previous===window.document,document) ||
            !await anchor.evaluate(e=>e.isConnected) || await region.count()!==1 ||
            !await region.evaluate((element,previous)=>element===previous,anchor,{timeout:Math.min(timeout,250)})) return blocked('readiness_changed');
        await expect(region).toBeVisible({timeout:Math.min(timeout,250)});
        await expect(region).toHaveText(check.ready.text,{timeout:Math.min(timeout,250)});
      } catch {return blocked('readiness_changed');}
    }
    if(check.condition!=='count' && await target.count()>1) return blocked('locator_ambiguous');
    if(failure) {
      if(page.isClosed() || !page.context().browser()?.isConnected()) return blocked('page_unavailable');
      return failure.matcherResult?{status:'failed',reason:'condition_not_met'}:blocked('observation_unavailable');
    }
    return {status:'passed',reason:'condition_matched'};
  } catch(error) {return blocked(/Unexpected token|not a valid selector|Unknown engine|while parsing.*selector/i.test(String(error.message))?'locator_invalid':'observation_unavailable');}
  finally {await anchor?.dispose().catch(()=>{});await document?.dispose().catch(()=>{});}
}

export async function observeUiCondition(target,condition) {
  if(condition==='count') return target.count();
  if(condition==='value') return target.inputValue({timeout:1000});
  if(condition==='text') return target.textContent({timeout:1000});
  if(condition==='readonly') return target.evaluate(e=>e.matches('input,textarea')?e.readOnly:null,undefined,{timeout:1000});
  if(condition==='editable') return target.isEditable({timeout:1000});
  if(condition==='enabled') return target.isEnabled({timeout:1000});
  if(condition==='disabled') return target.isDisabled({timeout:1000});
  return target.isVisible();
}
