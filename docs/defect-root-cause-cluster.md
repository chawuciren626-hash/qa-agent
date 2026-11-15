# 缺陷根因聚类（L-9）

## 一句话

**聚类只改展示分组，不改缺陷单数量。** 40 张单还是 40 张，只是报告上会写「这 40 张是同源问题，先看这一组」。

## 为什么不能不是这样

两个方向都翻过车：

| 做法 | 后果 |
|---|---|
| 精确指纹（现状） | 后端 500 打穿 40 条用例，`related_cases` 不同 → 40 个指纹 → **40 张单**，评审看到「40 个缺陷」 |
| 按标题相似度合并 | 「同样报 500 但根因不同」被合掉，**漏真缺陷**——这比多开单严重得多 |

所以：**单不动，只多一层分组**。人看报告先看组，提单时仍可逐张提。

## 聚类键：三个维度，缺一不聚

```
error.type + 顶层堆栈帧 + 接口路径
```

| 维度 | 归一化 | 为什么必须归一化 |
|---|---|---|
| `error.type` | `TypeError` / `HTTP500` / `Timeout` / `ConnectionRefused` / `AssertionFailed` | 同一类错误的字面表达五花八门 |
| 顶层堆栈帧 | 去 `:行:列`，保留 `函数名 (文件)` | 行号随构建飘，带行号会把同一个 bug 拆成两组 |
| 接口路径 | 数字段/UUID 段 → `:id`，保留版本号 | 40 条用例各查不同订单，`/orders/123` 与 `/orders/456` 是同一处代码 |

**缺一不聚**：只有 type 的组会把「所有 Timeout」聚成一簇，看起来像发现了大根因——这是假结论，比不聚更糟。

## 数据从哪来

缺陷正文常常只有 `actual_result` 一段话，没有 `error` 对象。所以签名按顺序取：

1. 记录上的 `error.{type,message,stack,path}`；
2. `execution/test_results.json` 里 `related_cases` 对应结果的 `error.*` / `failure_summary`；
3. 从 `actual_result` / `analysis` 文本里正则捞方法与路径。

捞不到就不聚，并在 `warnings` 里写明「N 张单缺可判证据，未参与聚类」——**这是「判不了」，不是「没关系」**。

## 用法

```bash
node scripts/defect-cluster.mjs --run-id=run-xxx
# → output/runs/run-xxx/defects/root-cause-clusters.json
```

产物：

```json
{ "merge_safety": "display_only",
  "stats": { "records": 40, "clustered_defects": 40, "clusters": 1, "tickets_before": 40, "groups_after": 1 },
  "clusters": [{ "cluster_id": "RC-1A2B3C4D", "size": 40, "representative": "DEF-P0", "summary": "40 张单同源：HTTP500 @ GET /api/orders/:id（OrderService.getById (/srv/app/order/service.js)），影响 40 条用例" }],
  "warnings": ["聚类只改展示分组，不改缺陷单数量与生命周期状态。"] }
```

`tickets_before` / `groups_after` 是给汇报用的两个数：**不聚类要开 40 张单，聚类后要人看 1 组**。

## 诚实边界

| 做得到 | 做不到 |
|---|---|
| 同源缺陷的展示分组、影响面、代表单 | 判断「两处不同代码是不是同一个业务缺陷」——那需要人 |
| 缺证据时明确拒聚 | 从自然语言描述里推断堆栈（没有就是没有） |
| 组内按严重度选代表 | 自动关单/合并单 |

## 与既有模块的边界

- `normalize-defects.mjs`：**不动**。它是缺陷单的生成方，改它的输出结构会破既有契约测试，也会让「单数」变得不可信。
- `defect-lifecycle.mjs`：生命周期仍按单管理，聚类不参与状态流转。
- 报告：B8 起由报告侧读取 `root-cause-clusters.json`，在缺陷章节前加一段分组说明。
