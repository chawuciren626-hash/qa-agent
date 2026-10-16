import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectExpectationBasis, expectationBasisRows, basisHeaders } from '../../scripts/expectation-basis.mjs';

const sources=new Map([['inputs/request.txt','Empty title: show Required. Over 50 characters: show Too long.']]);
const row=()=>({case_id:'CASE-1',expected:'Show Required.',expected_basis:[{expected:'Show Required.',kind:'requirement',source_path:'inputs/request.txt',quote:'Empty title: show Required.'}]});

test('basis records locate existing sources without approving semantics or requesting users',()=>{
  const result=inspectExpectationBasis(row(),sources);
  assert.equal(result.status,'source_located');assert.deepEqual(result.errors,[]);
  assert.equal(result.semantic_verified,false);assert.equal(result.approval_required,false);
  const legacy=inspectExpectationBasis({case_id:'old',expected:'Old case'},sources);
  assert.equal(legacy.status,'not_recorded');assert.deepEqual(legacy.errors,[]);assert.ok(legacy.warnings.length);
});

test('uncovered side effects, fabricated citations, foreign paths and assumptions are correctable draft errors',()=>{
  for(const change of [
    r=>r.expected+=' No data saved.',
    r=>r.expected_basis[0].quote='Never stored in database',
    r=>r.expected_basis[0].source_path='../other.txt',
    r=>r.expected_basis[0].kind='engineering_assumption',
    r=>r.expected_basis[0].expected='Absent clause',
    r=>r.expected_basis=[],
    r=>r.observations=[{statement:'Optional',kind:'requirement',reason:'Unknown'}]
  ]) {const value=row();change(value);const result=inspectExpectationBasis(value,sources);assert.ok(result.errors.length);assert.equal(result.approval_required,false);}
});

test('all clauses need coverage; a matching quotation alone cannot establish semantic entailment',()=>{
  const value=row();value.expected+=' Show Too long.';
  value.expected_basis.push({expected:'Show Too long.',kind:'contract',source_path:'inputs/request.txt',quote:'Over 50 characters: show Too long.'});
  assert.deepEqual(inspectExpectationBasis(value,sources).errors,[]);
  value.expected_basis[1].quote='Empty title: show Required.';
  const result=inspectExpectationBasis(value,sources);
  assert.equal(result.semantic_verified,false);
  assert.match(result.guidance,/does not prove semantic support/);
});

test('proposals remain separate from expected and workbook provenance is explicitly qualified',()=>{
  const value=row();value.observations=[{statement:'Should duplicates be rejected?',kind:'needs_confirmation',reason:'No definition supplied'}];
  assert.deepEqual(inspectExpectationBasis(value,sources).errors,[]);
  const table=expectationBasisRows([value]);
  assert.equal(table.length,2);assert.equal(table[0].length,basisHeaders.length);
  assert.match(table[1][1],/非验收断言/);assert.equal(value.expected,'Show Required.');
});
