---
name: anchor-verification
version: 2026.11.02.1
description: 验证测试点/用例的锚点引用在对应端×环境的系统地图中真实存在，输出按端锚定率与缺失清单。
task: none
tools: []
sections:
  criteria: ["验证规则（强制）", "禁止事项"]
  knowledge: ["锚点类型与来源"]
  steps: ["输入与产出", "工作步骤"]
---

# 锚点验证 Skill

路径基准：`docs/`、`schemas/`、`config/`、`maps/` 按 `project-action.mjs catalog` 返回的 `runtime_context.engine_root` 解析；run 内产物按派发的 run 根目录解析。

## 验证规则（强制）

- 按端×环境验证：测试点 `end` 为 web 就用 web 端环境的系统地图，web_admin 用管理端地图；`end` 为空串（未指定）的条目单列“端未确认”，不计入按端锚定率。
- 锚点引用三选一逐条核对：页面锚点必须命中 `maps/<env>/pages.json` 的页面条目（路由/页面标识）；接口锚点必须命中 `maps/<env>/apis.json` 或既有接口契约中的 operation；代码锚点必须指向真实存在的代码文件路径与符号。
- 只有 verified 条目算 verified 锚点；命中 candidate 记“待晋升”，未命中记“暂不可测”。两者都进缺失清单，但原因必须区分，不得混报。
- 输出按端锚定率（verified 锚点数/该端测试点数）与缺失清单（测试点 ID、锚点类型、引用值、缺失原因）。清单交回测试点角色修订；本 Skill 不修改设计产物。
- 地图新鲜度以环境地址＋探索时间为准；地图缺失或明显过期时，验证结论标注“地图缺失/新鲜度不足”，不把过期命中当作可靠 verified。

## 锚点类型与来源

| 类型 | 权威来源 | 核对依据 |
|---|---|---|
| 页面锚点 | 系统地图页面清单 | 路由/页面标识＋锚点 bundle（≥2 指纹） |
| 接口锚点 | 系统地图接口清单、既有接口契约 | operation（方法＋端点） |
| 代码锚点 | 被测代码仓库 | 文件路径＋符号（函数/组件/类） |

锚点由 system-map-exploration 探索产出（candidate），经人工评审晋升 verified；本 Skill 只消费状态，不改变状态。

## 输入与产出

输入：`design/test_points.json`（含 end 与锚点引用），可选 `design/test_cases.json`；对应端×环境的 `maps/<env>/pages.json`、`maps/<env>/apis.json`、`maps/<env>/coverage.json`；既有接口契约资料。

产出：验证结论（按端锚定率、缺失清单、新鲜度警告），交测试点角色与总控。不写设计文件，不晋升资产，不发起产品操作。

## 工作步骤

1. 读取测试点，按 `end` 分组；未指定端的进“端未确认”组。
2. 逐组加载对应环境的系统地图与契约；地图缺失时整组标注“地图缺失”，不猜测条目。
3. 逐条核对锚点引用，记录 verified/candidate/缺失三态及依据。
4. 汇总按端锚定率与缺失清单，输出验证结论；“暂不可测”条目保留在清单中，不静默剔除。

## 禁止事项

- 禁止把 candidate 标成 verified；禁止修改测试点、用例或系统地图来让验证通过。
- 禁止编造锚点，或把相似文案/相近路由当作同一锚点。
- 禁止为验证发起产品请求或浏览器操作；本 Skill 是只读核对。