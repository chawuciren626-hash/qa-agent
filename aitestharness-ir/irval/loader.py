"""严格 YAML 加载器。

三个必须在**解析阶段**解决的问题（解析后再查就晚了）：

1. **浮点字面量**（V-38）：`range: [0.01, 999999.99]` 必须报错。
   若先 `safe_load` 再检查类型，`"0.10"` 与 `0.1` 已经无法区分 —— 原始字面量丢了。
   做法：用 `yaml.compose` 拿节点树（不执行构造器），按 tag 判定，天然保留原始 token。

2. **时间戳**：PyYAML 会把 `2026-11-13T17:00:00+08:00` 解析成 `datetime`，
   导致 V-04 的"带时区"校验失去意义。覆写构造器，一律保留原始字符串。

3. **重复键**：YAML 默认静默覆盖，对契约文件是灾难（改了一半的字段被悄悄吞掉）。
"""

from __future__ import annotations

from typing import Any, Iterator

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from .errors import LoadError, SCHEMA_DUPLICATE_KEY, SCHEMA_FLOAT_NUMBER

TAG_FLOAT = "tag:yaml.org,2002:float"
TAG_TIMESTAMP = "tag:yaml.org,2002:timestamp"


class _ContractLoader(yaml.SafeLoader):
    """时间戳保留原文字符串，其余同 SafeLoader。"""


def _construct_timestamp(loader: _ContractLoader, node: ScalarNode) -> str:
    return node.value


_ContractLoader.add_constructor(TAG_TIMESTAMP, _construct_timestamp)


# ---------------------------------------------------------------- 节点遍历


def _iter_nodes(node: Node, path: str = "") -> Iterator[tuple[str, Node]]:
    """深度优先产出 (路径, 节点)。路径形如 `steps[0].wait[1].type`。"""
    yield path, node
    if isinstance(node, MappingNode):
        for key_node, value_node in node.value:
            key = key_node.value if isinstance(key_node, ScalarNode) else str(key_node)
            child = f"{path}.{key}" if path else str(key)
            yield from _iter_nodes(value_node, child)
    elif isinstance(node, SequenceNode):
        for i, item in enumerate(node.value):
            yield from _iter_nodes(item, f"{path}[{i}]")


def _check_duplicate_keys(node: Node, path: str = "") -> None:
    if isinstance(node, MappingNode):
        seen: dict[str, Any] = {}
        for key_node, _ in node.value:
            if isinstance(key_node, ScalarNode):
                k = key_node.value
                if k in seen:
                    raise LoadError(
                        SCHEMA_DUPLICATE_KEY,
                        f"{path}.{k}" if path else k,
                        f"重复键 `{k}`：YAML 默认静默覆盖，契约文件不允许",
                        line=key_node.start_mark.line + 1,
                        column=key_node.start_mark.column + 1,
                    )
                seen[k] = key_node
        for key_node, value_node in node.value:
            k = key_node.value if isinstance(key_node, ScalarNode) else ""
            child = f"{path}.{k}" if path else str(k)
            _check_duplicate_keys(value_node, child)
    elif isinstance(node, SequenceNode):
        for i, item in enumerate(node.value):
            _check_duplicate_keys(item, f"{path}[{i}]")


def _check_no_float(root: Node) -> None:
    for path, node in _iter_nodes(root):
        if isinstance(node, ScalarNode) and node.tag == TAG_FLOAT:
            raise LoadError(
                SCHEMA_FLOAT_NUMBER,
                path,
                f"浮点字面量 `{node.value}`：数值字段必须写成字符串十进制（避免 0.1+0.2 类误报）",
                line=node.start_mark.line + 1,
                column=node.start_mark.column + 1,
            )


# ---------------------------------------------------------------- 对外入口


def load(text: str) -> Any:
    """解析 YAML 文本；违反上述三条约束时抛 LoadError。"""
    try:
        root = yaml.compose(text, Loader=yaml.SafeLoader)
    except yaml.YAMLError as exc:  # 语法错误
        mark = getattr(exc, "problem_mark", None)
        raise LoadError(
            "SCHEMA_YAML_SYNTAX_ERROR",
            None,
            f"YAML 语法错误：{exc}",
            line=(mark.line + 1) if mark else None,
            column=(mark.column + 1) if mark else None,
        ) from exc

    if root is None:  # 空文件
        return None

    _check_no_float(root)
    _check_duplicate_keys(root)

    return yaml.load(text, Loader=_ContractLoader)


def load_file(path: str) -> Any:
    with open(path, "r", encoding="utf-8") as fh:
        return load(fh.read())
