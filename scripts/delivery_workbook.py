"""Portable delivery workbook using only the standard library."""
import json
import math
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
from xml.etree import ElementTree as ET

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
TEMPLATE = json.loads((Path(__file__).resolve().parents[1] / 'config/test-delivery-template.json').read_text(encoding='utf-8'))
STATUS = {'passed': '通过', 'failed': '失败', 'skipped': '未执行', 'blocked': '受阻', 'pending': '待确认', 'not_run': '未执行'}


def plain(value):
    if value is None: return ''
    if isinstance(value, bool): return 'true' if value else 'false'
    if isinstance(value, list): return '\n'.join(plain(v) for v in value)
    if isinstance(value, dict): return '\n'.join(f'{k}: {plain(v)}' for k, v in value.items())
    return str(value)


def extract_cases(value):
    return value if isinstance(value, list) else value.get('cases', value.get('test_cases', []))


def case_rows(cases, results=None, issues=None):
    actual = {r['case_id']: r for r in (results or {}).get('cases', [])}
    rows = []
    for case in cases:
        result = actual.get(case['case_id'])
        related = [i for i in issues or [] if case['case_id'] in i.get('related_cases', [])]
        steps = '\n'.join(f'{i + 1}. {s}' for i, s in enumerate(case.get('steps', [])))
        data = plain(case.get('test_data', {}))
        if data: steps += '\n测试数据:\n' + data
        state = STATUS.get(result.get('status'), '待确认') if result else '未执行'
        if result:
            outcome = plain(result.get('actual_result') or result.get('error_message') or result.get('reason'))
            if not outcome: outcome = '来源未提供实际结果说明；状态仅按记录展示。'
            source = result.get('report_source', {})
            tags = []
            if source.get('kind') == 'imported': tags.append('导入记录，非本智能体实测')
            elif source.get('kind') == 'unresolved': tags.append('来源未唯一确认')
            if source.get('fixture') is True or result.get('fixture') is True: tags.append('合成样例，非产品执行')
            if source.get('retained_text_fields'): tags.append('部分文字经转写，非来源原文')
            mode = result.get('evidence_mode')
            if mode == 'simulated':
                tags.append('模拟场景，不代表真实后端结果')
                state += '（模拟）'
            elif mode == 'simulation_affected':
                tags.append('受模拟影响')
                state += '（受模拟影响）'
            elif mode != 'real': tags.append('证据模式未记录')
            if tags: outcome = '；'.join(tags) + '\n' + outcome
        else: outcome = '本次未执行该用例。' if results is not None else '尚未执行。'
        refs = (result or {}).get('evidence_paths') or (result or {}).get('evidence_refs') or (result or {}).get('evidence') or []
        rows.append([case['case_id'], case.get('execution_metadata', {}).get('module', case.get('module', '未分组')),
                     case.get('priority', ''), case.get('title', ''), plain(case.get('preconditions', [])), steps,
                     plain(case.get('expected', (result or {}).get('expected', ''))), outcome, state,
                     '\n'.join(i.get('defect_id', i.get('bug_id', '')) for i in related), plain(refs)])
    return rows


def issue_rows(issues):
    return [[i.get('defect_id', i.get('bug_id', '')), i.get('priority', 'unknown'), i.get('lifecycle_status', 'needs_review'),
             i.get('title', i.get('summary', '')), i.get('category', 'needs_review'), plain(i.get('steps_to_reproduce', i.get('steps', []))),
             plain(i.get('expected_result', i.get('expected', ''))), plain(i.get('actual_result', i.get('actual', ''))),
             plain(i.get('impact', '')), plain(i.get('suggestion', i.get('recommendation', i.get('analysis', '')))), plain(i.get('evidence_refs', []))]
            for i in issues]


def expectation_basis_rows(cases):
    labels = {'requirement': '需求', 'contract': '接口/业务约定', 'ui_explicit': '界面明确约束',
              'engineering_assumption': '工程假设', 'needs_confirmation': '待确认'}
    rows = []
    for case in cases:
        for entry in case.get('expected_basis', []):
            rows.append([case['case_id'], '验收预期', entry['expected'], labels.get(entry['kind'], '未知'),
                         entry['source_path'], entry['quote'], '引用可核对，不代表语义已自动验证'])
        for entry in case.get('observations', []):
            rows.append([case['case_id'], '观察/建议（非验收断言）', entry['statement'], labels.get(entry['kind'], '未知'), '', '', entry['reason']])
    return rows


def column(index):
    value = ''
    while index:
        index, remainder = divmod(index - 1, 26)
        value = chr(65 + remainder) + value
    return value


def xml(element):
    return ET.tostring(element, encoding='utf-8', xml_declaration=True)


def write_workbook(path, title, subtitle, cases, issues=None, results=None):
    sheets = [('测试用例', TEMPLATE['case_headers'], TEMPLATE['case_widths'], case_rows(cases, results, issues)),
              ('问题清单', TEMPLATE['issue_headers'], TEMPLATE['issue_widths'], issue_rows(issues or []))]
    basis_rows = expectation_basis_rows(cases)
    if basis_rows:
        sheets.append(('预期依据', ['用例编号', '用途', '预期或观察', '依据类型', '来源文件', '原文摘录', '说明'],
                       [20, 28, 52, 22, 36, 60, 52], basis_rows))
    q = lambda name: f'{{{NS}}}{name}'
    files = {}
    workbook = ET.Element(q('workbook'))
    sheet_list = ET.SubElement(workbook, q('sheets'))
    definitions = ET.SubElement(workbook, q('definedNames'))
    relations = ET.Element('Relationships', xmlns='http://schemas.openxmlformats.org/package/2006/relationships')
    for index, (name, headers, widths, records) in enumerate(sheets, 1):
        ET.SubElement(sheet_list, q('sheet'), name=name, sheetId=str(index), attrib={f'{{{REL}}}id': f'rId{index}'})
        ET.SubElement(relations, 'Relationship', Id=f'rId{index}', Type=REL + '/worksheet', Target=f'worksheets/sheet{index}.xml')
        ET.SubElement(definitions, q('definedName'), name='_xlnm.Print_Titles', localSheetId=str(index - 1)).text = f"'{name}'!$1:$5"
        root = ET.Element(q('worksheet'))
        properties = ET.SubElement(root, q('sheetPr'))
        ET.SubElement(properties, q('pageSetUpPr'), fitToPage='1')
        views = ET.SubElement(root, q('sheetViews'))
        view = ET.SubElement(views, q('sheetView'), workbookViewId='0', showGridLines='0')
        ET.SubElement(view, q('pane'), xSplit='3', ySplit='5', topLeftCell='D6', activePane='bottomRight', state='frozen')
        cols = ET.SubElement(root, q('cols'))
        for n, width in enumerate(widths, 1): ET.SubElement(cols, q('col'), min=str(n), max=str(n), width=str(width), customWidth='1')
        data = ET.SubElement(root, q('sheetData'))
        rows = [[], [f'{title} · {name}'], [subtitle], [f'用例 {len(cases)} 条；问题记录 {len(issues or [])} 条。'], headers, *records]
        for r, values in enumerate(rows, 1):
            height = 28 if r == 2 else 32 if r == 5 else 24
            if r > 5:
                line_count = max((sum(max(1, math.ceil(sum(2 if ord(c) > 127 else 1 for c in line) / max(widths[j] - 2, 1))) for line in plain(v).split('\n')) for j, v in enumerate(values)), default=1)
                height = max(45, min(409, line_count * 15 + 12))
            row = ET.SubElement(data, q('row'), r=str(r), ht=str(height), customHeight='1')
            for c, value in enumerate(values, 1):
                style = 1 if r == 2 else 2 if r in (3, 4) else 3 if r == 5 else 4 if r % 2 == 0 else 0
                if r > 5 and name == '测试用例' and c == 9: style = {'通过': 5, '失败': 6, '待确认': 7, '受阻': 7, '未执行': 8}.get(value, style)
                cell = ET.SubElement(row, q('c'), r=f'{column(c)}{r}', t='inlineStr', s=str(style))
                ET.SubElement(ET.SubElement(cell, q('is')), q('t'), attrib={'{http://www.w3.org/XML/1998/namespace}space': 'preserve'}).text = plain(value)
        last_column = column(len(headers))
        ET.SubElement(root, q('autoFilter'), ref=f'A5:{last_column}{max(5, len(rows))}')
        merges = ET.SubElement(root, q('mergeCells'), count='3')
        for r in (2, 3, 4): ET.SubElement(merges, q('mergeCell'), ref=f'A{r}:{last_column}{r}')
        ET.SubElement(root, q('pageMargins'), left='0.25', right='0.25', top='0.4', bottom='0.4', header='0.2', footer='0.2')
        ET.SubElement(root, q('pageSetup'), paperSize='8', orientation='landscape', fitToWidth='1', fitToHeight='0')
        files[f'xl/worksheets/sheet{index}.xml'] = xml(root)
    ET.SubElement(relations, 'Relationship', Id=f'rId{len(sheets) + 1}', Type=REL + '/styles', Target='styles.xml')
    styles = ET.Element(q('styleSheet'))
    fonts = ET.SubElement(styles, q('fonts'), count='4')
    for size, color, bold in [(10, '24364B', False), (16, '16324F', True), (10, '66758A', False), (10, 'FFFFFF', True)]:
        font = ET.SubElement(fonts, q('font'))
        ET.SubElement(font, q('sz'), val=str(size)); ET.SubElement(font, q('name'), val='Microsoft YaHei')
        ET.SubElement(font, q('color'), rgb='FF' + color)
        if bold: ET.SubElement(font, q('b'))
    fills = ET.SubElement(styles, q('fills'), count='8')
    for color in [None, 'gray125', '16324F', 'F3F6FA', 'E2F2E9', 'FCE3E3', 'FFF0CA', 'E8EDF3']:
        pattern = ET.SubElement(ET.SubElement(fills, q('fill')), q('patternFill'), patternType='none' if color is None else 'gray125' if color == 'gray125' else 'solid')
        if color not in (None, 'gray125'): ET.SubElement(pattern, q('fgColor'), rgb='FF' + color)
    borders = ET.SubElement(styles, q('borders'), count='1'); ET.SubElement(borders, q('border'))
    base = ET.SubElement(styles, q('cellStyleXfs'), count='1'); ET.SubElement(base, q('xf'), numFmtId='0', fontId='0', fillId='0', borderId='0')
    xfs = ET.SubElement(styles, q('cellXfs'), count='9')
    for font, fill in [(0, 0), (1, 0), (2, 0), (3, 2), (0, 3), (0, 4), (0, 5), (0, 6), (0, 7)]:
        xf = ET.SubElement(xfs, q('xf'), numFmtId='0', fontId=str(font), fillId=str(fill), borderId='0', xfId='0', applyAlignment='1')
        ET.SubElement(xf, q('alignment'), vertical='top', wrapText='1')
    cell_styles = ET.SubElement(styles, q('cellStyles'), count='1'); ET.SubElement(cell_styles, q('cellStyle'), name='Normal', xfId='0', builtinId='0')
    content = ET.Element('Types', xmlns='http://schemas.openxmlformats.org/package/2006/content-types')
    for ext, typ in [('rels', 'application/vnd.openxmlformats-package.relationships+xml'), ('xml', 'application/xml')]: ET.SubElement(content, 'Default', Extension=ext, ContentType=typ)
    for name, typ in [('workbook.xml', 'sheet.main'), ('styles.xml', 'styles'), *[(f'worksheets/sheet{i}.xml', 'worksheet') for i in range(1, len(sheets) + 1)]]: ET.SubElement(content, 'Override', PartName='/xl/' + name, ContentType='application/vnd.openxmlformats-officedocument.spreadsheetml.' + typ + '+xml')
    package_rel = ET.Element('Relationships', xmlns='http://schemas.openxmlformats.org/package/2006/relationships')
    ET.SubElement(package_rel, 'Relationship', Id='rId1', Type=REL + '/officeDocument', Target='xl/workbook.xml')
    files.update({'[Content_Types].xml': xml(content), '_rels/.rels': xml(package_rel), 'xl/workbook.xml': xml(workbook), 'xl/_rels/workbook.xml.rels': xml(relations), 'xl/styles.xml': xml(styles)})
    target = Path(path); target.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(target, 'w', ZIP_DEFLATED) as archive:
        for name, data in files.items(): archive.writestr(name, data)
