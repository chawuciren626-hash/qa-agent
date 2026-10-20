import assert from 'node:assert/strict';
import { validateCountMetadata, resolveCaseReference } from './execution-counts.mjs';
import { textLengths } from './design-quality.mjs';
import { inspectExpectationBasis, basisKinds } from './expectation-basis.mjs';

const sourcePath=path=>typeof path==='string' && /^(?:inputs|analysis|execution\/browser-evidence)\/[^\\:\x00-\x1f]+\.(?:txt|md|json)$/.test(path) && !path.split('/').some(p=>['.','..',''].includes(p));

export function validateValueReference(ref) {
  assert(ref && Object.keys(ref).every(k=>['source_path','case_id','key'].includes(k)), 'Invalid value_ref');
  validateCountMetadata({case_ref:{source_path:ref.source_path,case_id:ref.case_id}});
  assert(typeof ref.key==='string' && ref.key.length>0 && ref.key.length<=100 && !['__proto__','constructor','prototype'].includes(ref.key), 'value_ref needs an own test_data key');
}

export function validateUiBasis(check) {
  if(check.text_mode!==undefined) assert(check.condition==='text' && ['exact','normalized'].includes(check.text_mode), 'text_mode is exact or normalized, for text assertions only');
  if(check.expected_basis!==undefined) {
    assert(Array.isArray(check.expected_basis) && check.expected_basis.length>0 && check.expected_basis.length<=12, 'Use 1-12 expected_basis entries');
    for(const entry of check.expected_basis) {
      assert(entry && Object.keys(entry).every(k=>['expected','kind','source_path','quote'].includes(k)) && basisKinds.includes(entry.kind) && sourcePath(entry.source_path), 'Invalid expected_basis source or kind; assumptions are not requirements');
      assert(['expected','quote'].every(k=>typeof entry[k]==='string' && entry[k].trim() && entry[k].length<=4000), 'Basis needs bounded expected clause and verbatim quote');
    }
  }
}

function caseRow(ref,read) {
  const reference=resolveCaseReference({source_path:ref.source_path,case_id:ref.case_id},read);
  const data=JSON.parse(read(ref.source_path).data);
  const rows=Array.isArray(data)?data:data.cases ?? data.test_cases;
  return {row:rows.find(row=>row.case_id===ref.case_id),reference};
}

// Resolve once before side effects. Re-reading an existing operation receipt must
// happen before this function, so source edits can never replay an old action.
export function resolveBrowserInputs(operation,readSource) {
  const files=new Map();
  const read=path=>{if(!files.has(path)) files.set(path,readSource(path));return files.get(path);};
  const op=structuredClone(operation),samples=[];
  const resolveValue=(check,usage)=>{
    if(!check?.value_ref) return;
    validateValueReference(check.value_ref);
    const {row,reference}=caseRow(check.value_ref,read);
    assert(Object.hasOwn(row.test_data ?? {},check.value_ref.key) && typeof row.test_data[check.value_ref.key]==='string', 'Referenced test_data must be an existing string; no conversion or sample fabrication');
    const value=row.test_data[check.value_ref.key];
    assert(value.length<=32000,'Referenced string exceeds bounded browser input size');
    check.value=value;
    samples.push({usage,...reference,key:check.value_ref.key,lengths:textLengths(value)});
  };
  resolveValue(op,'operation');resolveValue(op.assertion,'assertion');
  for(const [i,check] of (op.preconditions ?? []).entries()) resolveValue(check,`precondition_${i}`);
  const check=op.type==='assert'?op:op.assertion;
  let expectation=null;
  if(check) {
    let entries=check.expected_basis,origin=entries?'explicit':'not_recorded',design=null;
    if(!entries && check.case_ref) {
      const {row,reference}=caseRow(check.case_ref,read);design=reference;origin='design_reference_only';
      if(Array.isArray(row.expected_basis)) {
        const selected=row.expected===check.expected?row.expected_basis:row.expected_basis.filter(e=>e?.expected===check.expected);
        if(selected.length) {
          origin='design_basis';
          entries=selected.length<=12?selected.map(e=>e && Object.fromEntries(['expected','kind','source_path','quote'].map(k=>[k,e[k]]))):[];
          try {validateUiBasis({expected_basis:entries});}
          catch {entries=[];}
        }
      }
    }
    const sources=new Map(),sourceHashes=[];
    for(const entry of entries ?? []) if(sourcePath(entry?.source_path)) {
      try {
        const file=read(entry.source_path);
        if(file.data.length>2*1024*1024) continue;
        sources.set(entry.source_path,new TextDecoder('utf-8',{fatal:true}).decode(file.data));
        sourceHashes.push({path:entry.source_path,sha256:file.sha256});
      } catch { /* Missing optional basis is a recorded limitation, not an unlock. */ }
    }
    const inspected=inspectExpectationBasis({...check,expected_basis:entries},sources);
    expectation={origin,status:inspected.status,semantic_verified:false,approval_required:false,
      ...(design?{design_reference:design}:{}),sources:sourceHashes,
      ...(entries?{expected_basis:entries}:{}),errors:inspected.errors,warnings:inspected.warnings,
      interpretation:'Only source location and exact clause coverage are checked. A matched UI condition is not proof that its expectation is a valid business rule. Missing legacy basis is unverified, never invented.'};
  }
  return {operation:op,samples,expectation};
}

export function uiComparison(check) {
  return check.condition==='text'?(check.text_mode==='exact' || (check.value_ref && check.text_mode!=='normalized')?'exact_text':'normalized_text'):check.condition==='value'?'exact_value':check.condition;
}
