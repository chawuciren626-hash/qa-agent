import json
import sys
from pathlib import Path
from delivery_workbook import extract_cases, write_workbook

source, target = map(Path, sys.argv[1:3])
payload = json.loads(source.read_text(encoding='utf-8'))
write_workbook(target, '测试用例', '设计阶段交付；执行结果将在测试后单独交付。', extract_cases(payload))
print(str(target))
