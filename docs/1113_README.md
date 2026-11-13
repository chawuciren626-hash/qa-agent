# AITestHarness IR 产物校验器（M1 切片）

把《IR 契约规范 v1》的 38 条规则中的 **23 条**做成**可运行的代码**，并用 **97 个用例**证明它真的拦得住。

> 这不是"又一个 schema 校验脚本"。它要回答的是一个具体质疑：  
> **凭什么相信这套系统不会把"没测"说成"通过"？**  
> 答案是：不靠提示词约束模型，靠代码关卡 + 可复跑的拦截用例。

---

## 快速开始

```bash
cd aitestharness-ir

# 跑全部 97 个用例（约 4 秒）
python3 -m irval suite

# 校验单份产物（带产物库，X 层才有意义）
python3 -m irval validate fixtures/plan.valid.yaml --store fixtures

# 校验 agent 提交的片段是否越权写了不该写的字段
python3 -m irval check-payload /tmp/agent_payload.yaml --writer agent:test_case_agent

# 单测
python3 -m pytest tests -q
```

当前结果：

```
用例 97/97 通过 | 反例拦截率 62/62 = 100% | 正例误杀 0/35 | 规则覆盖 23 条
```

---

## 它到底拦住了什么

### 场景 A：agent 自己给闸盖章

计划入库前要过五道闸（定位唯一、断言可判定、数据不硬编码、可溯源、重放验证）。如果 agent 能写 `gates`，它大可以自己标"全部 pass"。

```
$ python3 -m irval check-payload agent_payload.yaml --writer agent:test_case_agent
{
  "result": "rejected",
  "code": "PERM_AGENT_WROTE_PROGRAM_FIELD",
  "findings": [ id / status / version / gates 全部被剥离 ],
  "cleaned_keys": ["module", "notes", "steps", "touched"]
}
```

**闸的写入权在编译器进程，不在被约束方手里。** 这跟"裁判不能由运动员兼任"是一回事。

### 场景 B：用例没有判定性断言

只有 `observe` 断言、没有 `decide` 断言的用例，跑出来永远 pass —— 等于没测。

```
SEM_NO_DECIDE_ASSERT  assertions  "没有任何 decide 级断言：这条用例跑出来永远 pass，等于没测"
```

### 场景 C：计划宣称"重放验证通过"，但那条执行记录不存在

```
XREF_GATE_EVIDENCE_NOT_FOUND  gates.replay_verified.exec_ref  "引用 EXEC-9999@1 不存在的产物"
```

这是"防假通过"的最后一环：闸可以是人工标的，但没有真实执行记录的 pass 不算数。

### 场景 D：模型自造结论

```
verdict: "基本通过"
→ SCHEMA_ENUM_INVALID  verdict  允许值 [pass, fail, flaky, skipped, inconclusive]
```

---

## 已实现的规则（23 / 24）

| 层                | 规则   | 含义                                             |
| ---------------- | ---- | ---------------------------------------------- |
| **S**（schema，静态） | V-01 | 公共头 12 字段齐全；approved 须有人工确认人                   |
|                  | V-02 | 枚举封闭（禁自造值如"基本通过"）                              |
|                  | V-03 | ID 前缀/格式/唯一（同 ID 新版本不算重复）                      |
|                  | V-04 | 时间 ISO8601 带时区；数值必须字符串十进制                      |
|                  | V-05 | 凭证明文（按**值形态**判定，不按字段名）                         |
|                  | V-06 | approved 必须字段齐全（draft 允许缺）                     |
|                  | V-07 | actor 必须 `program:`/`agent:`/`human:`          |
|                  | V-08 | 引用语法（`${ns.key}` 白名单 + 断言来源必须带版本）              |
|                  | V-38 | 浮点字面量在 **YAML 解析阶段**就拒绝                        |
| **M**（语义，单产物）    | V-14 | 预期必须可判定（observable + matcher + value）          |
|                  | V-15 | 至少一条 decide 断言                                 |
|                  | V-16 | 步骤数预算                                          |
|                  | V-17 | 五闸全绿 + 重放证据必须真实存在                              |
|                  | V-18 | 禁固定时长等待（`sleep` 与 `ms`）                        |
|                  | V-19 | 禁坐标与层级索引定位（语义 xpath 允许）                        |
|                  | V-20 | verdict 与 decide 断言一致性（处置是**改判**不是拒绝）          |
|                  | V-21 | inconclusive 必须有原因；非 inconclusive 不得带原因        |
|                  | V-35 | matcher 白名单 + 参数配套 + 正则安全                      |
|                  | V-37 | 一 case 一 plan（环境差异入 variants/）                 |
| **X**（跨产物）       | V-27 | 血缘上游必须存在（区分"ID 不存在"与"版本不存在"）                   |
|                  | V-30 | 断言来源必须指向真实存在的测试点预期                             |
|                  | V-31 | case_ref / gates 证据 / plan_ref / found_by 引用完整 |
| **分权**           | PERM | agent 不得写 program / human 专属字段                 |

**未实现**：V-33（覆盖率双向对账）—— 需要 suite 级聚合，属下一切片。其余 14 条属 M2/M3（依赖需求原文库、缺陷库、报告状态机）。

---

## 三个必须说明的设计决定

这几处是我在实现时**改动了契约原文**的地方，理由都写在代码注释里。

### 1. `exec` 免于人工确认（契约 2.2 的澄清）

契约说"approved 态必须有 `approved_by`"，但 `exec` 是机器事实记录，每次执行产生一条，不可能逐条人工签。

**处理**：`EXEMPT_APPROVER = {"exec"}`。它的可信性由 V-17（五闸）和 V-20（断言一致）保证，不靠签字。这不是放松，是把"可信"的来源换对了地方。

### 2. matcher 不走 V-02 枚举，交给 V-35

`matcher` 在 2.5 枚举字典里，但它需要**配套参数校验**（`between` 要 min/max，`regex` 要 pattern 且不能有嵌套量词）。若 V-02 先按枚举拦，同一个违规会同时命中两条规则，破坏"一个用例一个错误码"的正交性。

**处理**：`enum_for_path` 不映射 matcher，V-35 独占这一块，输出更精确的 `SEM_MATCHER_NOT_WHITELISTED` / `SEM_MATCHER_ARGS_MISSING` / `SEM_REGEX_UNSAFE`。

### 3. `null` 不算枚举违规

`inconclusive_kind: null` 是合法状态（非 inconclusive 时就该为空）。把 null 当非法会误杀。

**处理**：V-02 跳过 `None`，"该不该有值"交给条件必填规则（V-21）判定。**枚举管"给了值是否合法"，必填管"该不该给"。**

---

## 两个实现细节（都踩过坑）

### 浮点必须在解析阶段拦，不能解析后查

```python
# 错：先 safe_load 再检查类型 —— 原始字面量已经丢了
doc = yaml.safe_load(text)
assert isinstance(doc["range"][0], str)   # "0.10" 与 0.1 已无法区分

# 对：compose 拿节点树（不执行构造器），按 tag 判定
root = yaml.compose(text)
# tag == 'tag:yaml.org,2002:float' → 报错，并给出路径 data_constraints[0].range[0]
```

顺带解决第二个坑：PyYAML 会把 `2026-11-13T17:00:00+08:00` 解析成 `datetime`，导致 V-04 的"带时区"校验失去意义。覆写 timestamp 构造器保留原文。

### 口令识别必须先排除合法标识，再套启发式

第一版把 `FRAG-login@2` 判成了密码（大写+小写+数字+`@`）。这不是小 bug —— **被误杀的规则会被团队直接关掉**，比漏杀更伤。

现在有 8 条 `SAFE_VALUE_PATTERNS`（引用、scheme://、产物 ID、页面路径、指纹、版本号、纯小写标识）先过一遍，剩下的才套启发式。

---

## 目录结构

```
aitestharness-ir/
├── irval/
│   ├── enums.py            # 2.5 枚举字典（唯一权威来源）
│   ├── errors.py           # 错误码 + Finding/Result
│   ├── loader.py           # 严格 YAML（禁 float / 保留时区原文 / 查重复键）
│   ├── ownership.py        # 字段分权（PERM）
│   ├── schema_rules.py     # S 层 V-01~V-08、V-38
│   ├── semantic_rules.py   # M 层 V-14~V-21、V-35、V-37
│   ├── xref_rules.py       # X 层 V-27、V-30、V-31
│   ├── store.py            # 内存产物库（X 层用）
│   ├── pipeline.py         # S → M → X 顺序编排
│   └── cli.py              # validate / check-payload / suite
├── fixtures/               # 合规基线（_ 前缀是给用例用的状态基线，不入库）
├── suite/
│   ├── cases.py            # 97 个用例定义
│   └── runner.py           # 执行 + 三重判定（result + code + field）
└── tests/test_s_layer.py   # pytest 包装
```

---

## 加一条新规则要做什么

1. 在 `errors.py` 加错误码（`SCHEMA_` / `SEM_` / `XREF_` / `PERM_` 前缀）；
2. 在对应层模块写检查函数，**只报一个码**、带 `field` 路径；
3. 在 `CASES` 里加 **≥1 正例 + ≥2 反例**，反例只改一处；
4. 跑 `python3 -m irval suite`，必须全绿且反例拦截率 100%。

**第 3 步的"只改一处"是硬要求**：改三处的反例无法证明是哪条规则拦住的。

---

## 下一步（按价值排序）

| # | 内容                  | 为什么现在做                                   |
| - | ------------------- | ---------------------------------------- |
| 1 | **V-33 覆盖率双向对账**    | 唯一缺的 M1 规则，纯集合运算、零 LLM，一天能完成             |
| 2 | **固化编译器五闸的真实实现**    | 目前 `gates` 是数据契约，还没有真正跑五道闸的代码            |
| 3 | **第一条垂直切片的执行引擎**    | 接口自动化：DSL → HTTP 调用 → 结果 IR，能证明"重放零 LLM" |
| 4 | **evidence 包结构与脱敏** | 契约里标了 O-2 未定，落地前必须定                      |

第 2、3 项一旦跑通，M1 的四条量化验收（3 次执行结果一致、取证包可归因、耗时被记录、改动能产出 diff）就有了实测数据 —— 那是向领导证明这套东西有效的第一份硬证据。
