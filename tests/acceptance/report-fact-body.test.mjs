import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reportFactBody } from '../../scripts/report-fact-body.mjs';

test('lifecycle report conclusion follows metrics and execution facts', () => {
  const body=reportFactBody({runId:'run-1',results:{status:'failed',summary:{total:3,passed:1,failed:1,blocked:1,skipped:0}},
    issues:{records:[{defect_id:'D-1'}]},metrics:{quality_gate:{status:'review_required',reasons:['insufficient_failed_evidence']}}});
  assert.match(body,/通过 1，失败 1，受阻 1/);
  assert.match(body,/缺陷或问题记录 1 条/);
  assert.match(body,/质量门：review_required/);
  assert.doesNotMatch(body,/全部通过|零风险|完整覆盖/);
});

test('partial task report names untested scope without treating assertions as full coverage', () => {
  const body=reportFactBody({runId:'run-2',results:{status:'partial',summary:{total:1,passed:1,failed:0,blocked:0,skipped:0},coverage:{untested:['支付流程']}},issues:[]});
  assert.match(body,/未测：支付流程/);
  assert.match(body,/本次结果不完整/);
  assert.match(body,/不作质量门通过判断/);
});
