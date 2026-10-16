import json
import re
from html import escape
from pathlib import Path
from delivery_workbook import TEMPLATE, case_rows, issue_rows, plain, extract_cases, write_workbook


def markdown_body(markdown):
    lines = markdown.lstrip('\ufeff').splitlines()
    # Only a closed, leading metadata block is front matter; keep body separators.
    if lines and lines[0].strip() == '---':
        for index in range(1, len(lines)):
            if lines[index].strip() in ('---', '...'):
                return '\n'.join(lines[index + 1:])
    return '\n'.join(lines)


def markdown_blocks(markdown):
    lines = markdown_body(markdown).splitlines()
    index = 0
    while index < len(lines):
        line = lines[index].strip()
        if line.startswith('|'):
            table = []
            while index < len(lines) and lines[index].strip().startswith('|'):
                cells = [c.strip().replace('\\|', '|') for c in re.split(r'(?<!\\)\|', lines[index].strip().strip('|'))]
                if not all(re.fullmatch(r':?-{3,}:?', c) for c in cells): table.append(cells)
                index += 1
            if table: yield 'table', table
            continue
        if line and not re.fullmatch(r'[-*_]{3,}', line):
            if line.startswith('#'): yield 'heading', re.sub(r'^#+\s*', '', line)
            elif re.match(r'^[-*]\s+|^\d+\.\s+', line): yield 'bullet', re.sub(r'^[-*]\s+|^\d+\.\s+', '', line)
            else: yield 'body', line.lstrip('> ')
        index += 1


def html_table(headers, rows, table_id=''):
    def cell(value): return escape(plain(value)).replace('\n', '<br>')
    return '<div class="scroll"><table' + (f' id="{table_id}"' if table_id else '') + '><thead><tr>' + ''.join('<th>' + cell(h) + '</th>' for h in headers) + '</tr></thead><tbody>' + ''.join('<tr>' + ''.join('<td>' + cell(v) + '</td>' for v in r) + '</tr>' for r in rows) + '</tbody></table></div>'


def export_browser_delivery(report_dir, title, markdown, results, issues, metrics):
    directory = Path(report_dir)
    design = directory.parent / 'design/test_cases.json'
    manifest_path = directory.parent / 'manifest.json'
    if manifest_path.is_file():
        manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        if manifest.get('orchestration', {}).get('plan', {}).get('workflow_mode') == 'task':
            events = manifest.get('orchestration', {}).get('events', [])
            dispatch = next((event for event in reversed(events) if event.get('type') == 'dispatched' and event.get('stage') == 'report'), {})
            sources = dispatch.get('available_sources')
            valid = any(f.get('path') == 'design/test_cases.json' for f in sources) if sources is not None else any(event.get('type') == 'completed' and any(f.get('path') == 'design/test_cases.json' for f in event.get('evidence', {}).get('artifact_contract', {}).get('files', [])) for event in events)
            if not valid: design = directory.parent / 'design/.no-completed-case-source'
    cases = extract_cases(json.loads(design.read_text(encoding='utf-8'))) if design.is_file() else []
    # A blocked report may have no design source; retain every actual result if present.
    seen = {c['case_id'] for c in cases}
    cases += [dict(r, title=r.get('title', r['case_id'])) for r in results.get('cases', []) if r['case_id'] not in seen]
    rows = case_rows(cases, results, issues)
    subtitle = '结果记录快照；导入、合成及模拟属性见实际结果列；状态不等于真实产品验收。'
    write_workbook(directory / 'test_cases.xlsx', title, subtitle, cases, issues, results)
    body = []
    for kind, value in markdown_blocks(markdown):
        if kind == 'table': body.append(html_table(value[0], value[1:]))
        elif kind == 'heading':
            if value != title: body.append('<h2>' + escape(value) + '</h2>')
        else: body.append('<p>' + escape(value).replace('\n', '<br>') + '</p>')
    summary = results.get('summary', {})
    counts = [('结果记录', summary.get('total', 0)), ('通过', summary.get('passed', 0)), ('失败', summary.get('failed', 0)), ('受阻', summary.get('blocked', 0)), ('跳过', summary.get('skipped', 0)), ('问题记录', len(issues))]
    style = '''*{box-sizing:border-box}body{margin:0;background:#f3f6fa;color:#24364b;font:15px/1.7 "Microsoft YaHei",Arial,sans-serif}main{max-width:1240px;margin:auto;padding:32px 24px}h1{font-size:30px;margin:0 0 10px;color:#16324f}h2{font-size:21px;margin:30px 0 12px}p{overflow-wrap:anywhere}.muted{color:#66758a}.metrics{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:12px;margin:24px 0}.metric{background:white;border:1px solid #dce5ef;border-radius:6px;padding:12px}.metric strong{display:block;font-size:27px}.scroll{overflow:auto;margin:12px 0}table{border-collapse:collapse;width:100%;font-size:13px;background:white}th,td{padding:10px 12px;border-bottom:1px solid #dce5ef;vertical-align:top;min-width:110px;overflow-wrap:anywhere}th{background:#16324f;color:white;text-align:left}tr:nth-child(even){background:#f3f6fa}#cases{min-width:2000px}.toolbar{display:flex;gap:12px;flex-wrap:wrap}input,select{padding:9px;border:1px solid #bfcddd;border-radius:4px;font:inherit}a{color:#1e65aa}.note{border-left:4px solid #bd8432;padding:8px 16px;background:#fff7e6}@media(max-width:760px){main{padding:18px 12px}.metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}@media print{main{max-width:none;padding:0}.toolbar{display:none}.scroll{overflow:visible}#cases{min-width:0;font-size:8px}th,td{min-width:0;padding:5px}h2{break-after:avoid}}'''
    toolbar = '<div class="toolbar"><input id="search" aria-label="搜索测试用例" placeholder="搜索模块、用例、问题编号"><select id="status" aria-label="执行结果"><option value="">全部结果</option>' + ''.join(f'<option>{s}</option>' for s in ['通过','失败','待确认','受阻','未执行']) + '</select><span id="count"></span></div>'
    script = '''const search=document.getElementById('search'),status=document.getElementById('status');function filter(){let n=0;document.querySelectorAll('#cases tbody tr').forEach(r=>{r.hidden=!r.textContent.toLowerCase().includes(search.value.toLowerCase())||(status.value&&!r.cells[8].textContent.startsWith(status.value));if(!r.hidden)n++});document.getElementById('count').textContent=n+' 条'}search.addEventListener('input',filter);status.addEventListener('change',filter);filter();'''
    gate = metrics.get('quality_gate', {}).get('status')
    gate_html = '<p class="note">质量门：' + escape(gate) + '</p>' if gate else ''
    result = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + escape(title) + '</title><style>' + style + '</style></head><body><main><h1>' + escape(title) + '</h1><p class="muted">' + escape(results.get('run_id', '')) + '</p>' + gate_html + '<div class="metrics">' + ''.join(f'<div class="metric"><strong>{v}</strong>{k}</div>' for k,v in counts) + '</div>' + ''.join(body) + '<h2>问题清单</h2>' + html_table(TEMPLATE['issue_headers'], issue_rows(issues)) + '<h2>逐条测试用例</h2><p><a href="test_cases.xlsx">下载执行版用例 Excel</a> · <a href="test_report.docx">Word 报告</a> · <a href="test_report.pdf">PDF 报告</a></p>' + toolbar + html_table(TEMPLATE['case_headers'], rows, 'cases') + '</main><script>' + script + '</script></body></html>'
    (directory / 'test_report.html').write_text(result, encoding='utf-8')
