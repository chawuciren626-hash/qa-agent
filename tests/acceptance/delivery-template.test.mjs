import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import xlsx from '../../scripts/spreadsheet-runtime.mjs';
import { probePython } from '../../scripts/command-runtime.mjs';

test('delivery exports preserve unexecuted cases, evidence, issues and Markdown tables', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'delivery-template-'));
  mkdirSync(resolve(dir, 'design')); mkdirSync(resolve(dir, 'report'));
  const cases = [1,2,3].map(n => ({case_id:`TC-${n}`, title:n === 1 ? '<script>alert(1)</script>' : `Case ${n}`, priority:'P1', steps:['Open page','Check result'], test_data:{query:'=1+1'}, expected:'Expected', preconditions:[], status:'passed'}));
  const results = {run_id:'template-fixture',status:'completed',summary:{total:2,passed:1,failed:1,skipped:0,blocked:0},cases:[{case_id:'TC-1',status:'passed',evidence_paths:['evidence/one.png']},{case_id:'TC-2',status:'failed',actual_result:'Observed failure',evidence_paths:['evidence/two.png']}]};
  const bugs = [{defect_id:'D-1',title:'Candidate issue',related_cases:['TC-2'],category:'needs_review',steps_to_reproduce:['Open page'],impact:'Task incomplete'}];
  for (const [name,data] of [['design/test_cases.json',cases],['results.json',results],['bugs.json',bugs]]) writeFileSync(resolve(dir,name),JSON.stringify(data));
  writeFileSync(resolve(dir,'report/test_report.md'),'---\nrun_id: FRONTMATTER_SENTINEL\n---\n# Template report\n\n## Findings\n\n| Check | Observation |\n| --- | --- |\n| TABLE_SENTINEL | Content survives |\n');
  const python=probePython(); assert.equal(python.status,'ready');
  const run = (script,args) => {const r=spawnSync(python.executable,[resolve('scripts',script),...args],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:120000});assert.equal(r.status,0,r.stderr);};
  run('generate-test-cases-workbook.py',[resolve(dir,'design/test_cases.json'),resolve(dir,'design/test_cases.xlsx')]);
  let book=xlsx.readFile(resolve(dir,'design/test_cases.xlsx'));
  assert.deepEqual(book.SheetNames,['测试用例','问题清单']);
  assert.equal(book.Sheets['测试用例'].A5.v,'编号');
  assert.equal(book.Sheets['测试用例'].I6.v,'未执行');
  assert.equal(book.Sheets['测试用例'].H6.v,'尚未执行。');
  run('generate-report-documents.py',['report/test_report.md','results.json','bugs.json','report/test_report.docx','report/test_report.pdf'].map(p=>resolve(dir,p)));
  book=xlsx.readFile(resolve(dir,'report/test_cases.xlsx'));
  const sheet=book.Sheets['测试用例'];
  assert.equal(sheet.I6.v,'通过'); assert.equal(sheet.I7.v,'失败'); assert.equal(sheet.I8.v,'未执行');
  assert.equal(sheet.K6.v,'evidence/one.png'); assert.equal(sheet.J7.v,'D-1');
  assert.equal(book.Sheets['问题清单'].F6.v,'Open page');
  assert.equal(book.Sheets['问题清单'].I6.v,'Task incomplete');
  assert.equal(sheet.F6.f,undefined);
  const html=readFileSync(resolve(dir,'report/test_report.html'),'utf8');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('TABLE_SENTINEL')); assert.ok(html.includes('id="search"'));
  assert.ok(!html.includes('FRONTMATTER_SENTINEL'));
  assert.ok(!html.includes('not_assessed'));
  assert.ok(!html.includes('质量门：'));
  const check=spawnSync(python.executable,['-c','from docx import Document; import sys; d=Document(sys.argv[1]); assert any("TABLE_SENTINEL" in c.text for t in d.tables for r in t.rows for c in r.cells); text="\\n".join(p.text for p in d.paragraphs); assert "FRONTMATTER_SENTINEL" not in text; assert "质量门状态" not in text; assert "历史未关闭问题" not in text',resolve(dir,'report/test_report.docx')],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(check.status,0,check.stderr);
  assert.equal(readFileSync(resolve(dir,'report/test_report.pdf')).subarray(0,5).toString(),'%PDF-');
  console.log(JSON.stringify({template_preview:dir}));
});

test('Markdown removes only closed leading front matter and preserves body content',()=>{
  const python=probePython();assert.equal(python.status,'ready');
  const check=spawnSync(python.executable,['-c',String.raw`import sys
sys.path.insert(0, sys.argv[1])
from report_delivery import markdown_body, markdown_blocks
assert markdown_body('\ufeff---\r\nrun_id: metadata\r\n...\r\n# Report') == '# Report'
assert markdown_body('---\nUnclosed metadata') == '---\nUnclosed metadata'
assert markdown_body('# Report\n---\nrun_id: body') == '# Report\n---\nrun_id: body'
assert ('body', 'run_id: body') in list(markdown_blocks('# Report\n---\nrun_id: body'))
`,resolve('scripts')],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
  assert.equal(check.status,0,check.stderr);
});

test('lifecycle exports retain actual quality gate and distinguish unknown historical count from zero',()=>{
  const python=probePython();assert.equal(python.status,'ready');
  for(const known of [false,true]) {
    const dir=mkdtempSync(resolve(tmpdir(),'report-lifecycle-'));mkdirSync(resolve(dir,'report'));
    const results={run_id:'lifecycle-fixture',status:'completed',summary:{total:0,passed:0,failed:0,skipped:0,blocked:0},cases:[]};
    const metrics={quality_gate:{status:'review_required',reasons:[]},governance:{ledger_sha256:null,current:[],history:[],...(known?{open_historical:[]}: {})}};
    for(const [name,data] of [['results.json',results],['bugs.json',[]],['report/quality-metrics.json',metrics]]) writeFileSync(resolve(dir,name),JSON.stringify(data));
    writeFileSync(resolve(dir,'report/test_report.md'),'# Lifecycle report\nEvidence remains limited.');
    const args=['report/test_report.md','results.json','bugs.json','report/test_report.docx','report/test_report.pdf','report/quality-metrics.json'].map(p=>resolve(dir,p));
    const generated=spawnSync(python.executable,[resolve('scripts/generate-report-documents.py'),...args],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:120000});
    assert.equal(generated.status,0,generated.stderr);
    const expected=known?'历史未关闭问题: 0':'历史未关闭问题: 未评估';
    const check=spawnSync(python.executable,['-c','from docx import Document; import sys; text="\\n".join(p.text for p in Document(sys.argv[1]).paragraphs); assert "质量门状态: review_required" in text; assert sys.argv[2] in text',resolve(dir,'report/test_report.docx'),expected],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
    assert.equal(check.status,0,check.stderr);
    assert.ok(readFileSync(resolve(dir,'report/test_report.html'),'utf8').includes('质量门：review_required'));
    metrics.governance.integrity_error=true;
    writeFileSync(resolve(dir,'report/quality-metrics.json'),JSON.stringify(metrics));
    const invalid=spawnSync(python.executable,[resolve('scripts/generate-report-documents.py'),...args],{encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'},timeout:120000});
    assert.notEqual(invalid.status,0);
    assert.match(invalid.stderr,/Lifecycle evidence is invalid/);
  }
});
