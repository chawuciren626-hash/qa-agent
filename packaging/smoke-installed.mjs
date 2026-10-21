// Exercise delivered tools with no developer runtimes on PATH. No models or external sites.
import {mkdirSync,writeFileSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
if(process.argv.length!==4)throw Error('Usage: smoke-installed.mjs <installation-root> <new-evidence-directory>');
const root=resolve(process.argv[2]),out=resolve(process.argv[3]);
mkdirSync(out); // Refuse overwriting previous evidence.
const engine=join(root,'app/engine'),node=join(root,'runtime/tools/node/node.exe'),python=join(root,'runtime/tools/python/python.exe');
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!['path','pythonpath','pythonhome','node_path'].includes(key.toLowerCase())));
env.PATH=join(process.env.SystemRoot??'C:/Windows','System32');
env.PYTHONUTF8='1';env.PYTHONIOENCODING='utf-8';env.PLAYWRIGHT_BROWSERS_PATH=join(root,'runtime/tools/browsers');
const json=(name,value)=>writeFileSync(join(out,name),JSON.stringify(value));
const run=(exe,args)=>execFileSync(exe,args,{cwd:out,env,encoding:'utf8',windowsHide:true,timeout:120000});
json('points.json',{title:'安装运行时验证',points:[{id:'TP-1',module:'安装',feature:'内置工具',description:'独立生成交付文件'}]});
json('cases.json',{cases:[{case_id:'TC-1',title:'合成安装验证',steps:['生成文件'],expected:'文件结构可读取'}]});
json('results.json',{run_id:'installation-smoke',status:'completed',summary:{total:1,passed:1,failed:0,skipped:0,blocked:0},cases:[{case_id:'TC-1',status:'passed',actual_result:'合成样例，仅验证导出器',fixture:true,evidence_mode:'simulated'}]});
json('bugs.json',[]);writeFileSync(join(out,'report.md'),'# 安装运行时验证\n\n合成数据，仅验证内置导出工具，不代表真实测试业务验收。\n');
run(node,[join(engine,'scripts/generate-test-points-xmind.mjs'),join(out,'points.json'),join(out,'points.xmind')]);
run(python,[join(engine,'scripts/generate-test-cases-workbook.py'),join(out,'cases.json'),join(out,'cases.xlsx')]);
run(python,[join(engine,'scripts/generate-report-documents.py'),...['report.md','results.json','bugs.json','test_report.docx','test_report.pdf'].map(n=>join(out,n))]);
run(python,['-c',"import sys,zipfile; from pathlib import Path; from docx import Document; p=Path(sys.argv[1]); [zipfile.ZipFile(p/n).testzip() is None or sys.exit(1) for n in ['points.xmind','cases.xlsx','test_report.docx']]; assert len(Document(p/'test_report.docx').paragraphs)>0; pdf=(p/'test_report.pdf').read_bytes(); assert pdf.startswith(b'%PDF-') and pdf.rstrip().endswith(b'%%EOF')",out]);
// Run in a child to ensure Playwright sees only the sanitized environment.
const browserScript=join(out,'browser.cjs');
writeFileSync(browserScript,`const {chromium}=require(${JSON.stringify(createRequire(join(engine,'package.json')).resolve('playwright'))});(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<title>Installed browser smoke</title><h1>内置浏览器</h1>');if(await page.title()!=='Installed browser smoke')throw Error('Wrong title');await page.screenshot({path:${JSON.stringify(join(out,'browser.png'))}});}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1});`);
run(node,[browserScript]);
const files=['points.xmind','cases.xlsx','test_report.docx','test_report.pdf','test_report.html','test_cases.xlsx','browser.png'];
const result={status:'passed',scope:'installed_runtime_synthetic_smoke',developer_path_removed:true,model_calls:0,files:Object.fromEntries(files.map(n=>[n,statSync(join(out,n)).size]))};
json('result.json',result);console.log(JSON.stringify(result,null,2));
