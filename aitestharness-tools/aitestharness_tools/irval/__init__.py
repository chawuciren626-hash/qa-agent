"""AITestHarness IR 产物校验器（M1 切片）。

契约依据：《AITestHarness-IR契约规范-v1.md》第 5 章。
验收依据：《AITestHarness校验器测试用例集-v1.md》。

已实现 23 条规则：
- S 层：V-01~V-08、V-38
- M 层：V-14~V-21、V-35、V-37
- X 层：V-27、V-30、V-31
- 分权：PERM

未实现：V-33（覆盖率双向对账），依赖 suite 级聚合，属下一切片。
"""

from __future__ import annotations

from .errors import Finding, Result
from .pipeline import validate
from .store import Store

__all__ = ["Finding", "Result", "Store", "validate"]
__version__ = "0.2.0"
