# P6 结果闭环 — 落地记录 2026-11-19

## 0. 一句话

G9 让"地图变了"判得出来（已完成，commit `f45d8f5`）；G4 让"同一个测试点"跨批次还是同一条——`point_uid` 稳定身份 + 缺陷挂点 + 项目级覆盖率（本轮）。**漏测回流与地图增量回流没有做**，原因是缺数据源（见 §7），不假装完成。

## 1. 问题：为什么"跑得越多"不一定"越省力"

测试点的身份原来是 `(batch_id, point_key)`。每个批次重新编号，于是：

| 想问的问题 | 原实现答不出 | 后果 |
|---|---|---|
| 这条缺陷属于哪个测试点 | 缺陷只记 `related_cases_json`，而 `case_key` 是批次内编号 | 换个批次归属就断了，缺陷库沉淀不出"哪个点最爱出问题" |
| 这个测试点上一轮跑过没有 | 每批各算各的覆盖率 | 覆盖率只看本轮，历史从不参与判断 |
| 项目级到底覆盖了多少 | 只能按批次相加 | 同一件事被数成 N 个点，覆盖率虚高、看起来"覆盖很多" |

这三件事共同构成"每轮都从零开始"：结论写不进下一个任务的起点。

## 2. `point_uid`：由内容算出来的身份

`services/qa-point-identity.ts`

**输入口径（用户 2026-11-19 确认）**：需求引用 + 模块 + 功能 + 描述。

```
uid = sha256( requirementRefs.join('\x1f') + '\0' + module + '\0' + feature + '\0' + description ).slice(0,32)
```

四条设计约束，每条都对应一类错：

1. **不算可调项**（`risk` / `coverageType` / `executionLayer` / 验证方式）。把它们算进身份，等于"人调一次风险等级，这个测试点就变成新的一条"——历史执行结果、缺陷归属全部断开，uid 也就失去唯一价值。
2. **算需求引用**。两个模块下描述字面相同的边界点（"空输入校验"）是两件事；`document:<id>` / `rule:<id>` 能分开，且**不含 revision**——文档升一版不该让所有测试点换身份。
3. **归一化只做无损处理**：NFKC + 空白折叠 + 小写。**不做**同义词替换、标点删除、截断。宁可"改一版措辞算新测试点"（噪声），不要"误合并两条不同测试点"（错误）。
4. **空字段照常参与**。跳过会让"没有模块"与"模块是别的值"算出同一个结果——那是把缺失当成值。

**批次内防冲突**：同批次出现相同 uid → `400 duplicate_point` 拒绝整批，并区分两种情况——描述一致是"重复设计，应当合并"，描述只差大小写/空格是"归一化把它们拉平了，必须改描述"。**不悄悄合并**：合错之后归属永久错、且没有痕迹。

## 3. 迁移与回填

`db/migrations/steps/2026-11-19-point-uid.ts`

- `qa_test_points.point_uid`（TEXT）+ 索引 `idx_qa_test_points_uid(project_id, point_uid)`——覆盖率与缺陷挂点都按这两列找"同一测试点的所有批次"，没索引进退化成全表扫；
- `qa_defects.related_points_json`（TEXT NOT NULL DEFAULT `'[]'`）；
- **回填只补 `point_uid IS NULL`**，可重复执行；输入全部来自库里已有的列（module/feature/description/evidence_refs），不依赖外部文件——迁移跑完之后历史批次与新批次是同一套规则；
- 坏 JSON 不阻断迁移：该行按"没有需求引用"算，uid 仍确定，只是少了需求维度。

**回填会留下一种真实情况**：早期批次的证据引用可能缺 `documentId`，于是同一测试点在早期批次与现在算出的 uid 不同。这不是 bug，是当时没记来源的代价。处理方法写进迁移注释——**按 uid 分组时看不到老批次那一条，而不是把它硬合并到某个新 uid 上**。硬合并的危险在于合错之后归属永久错，且无痕迹。

## 4. 缺陷挂测试点

`services/qa-quality-traceability.ts`

- `discoverDefect` 按 `关联用例 → related_point_key → point_uid` 算 `relatedPoints`，写进 `related_points_json`；
- **算不出来就是空数组，不倒推**：让缺陷挂点少一个，好过挂一个错的（"不知道"与"没有关联测试点"是两件事）。
- **归并要求并集**：同一条缺陷从不同用例/不同批次复现时，只记第一次会把"这条缺陷影响哪几个测试点"永久截断。并集**排序后存储**，让"同一组归属"无论观测顺序如何都存成同一个值（本轮实测踩到：不排序时同样两条 uid 因先后不同写成两个样子，测试反复重试才定位到）；
- 历史缺陷的 `related_points_json` 保持 `[]`（当时没记 uid，倒推不出可靠归属）。

`DefectView.relatedPoints` 同时进 API 返回，前端与报告都能读。

## 5. 覆盖率：两种覆盖率必须分开

`Coverage.points[].pointUid` + `pointUid.history` + `Coverage.identity`

这是本轮最需要克制的部分：**本轮的 `counts`/`rates`/`gate` 一个字都没改**。

| 视角 | 字段 | 回答的问题 | 是否进 gate |
|---|---|---|---|
| 本批次 | `counts` / `rates` / `points[].status` | 这次设计的点覆盖成什么样 | ✅ 是 |
| 历史 | `points[].history` | 这个点以前设计/执行过几次、上次什么结论 | ❌ 否 |
| 项目级 | `identity` | 项目至今覆盖了多少个不同的点 | ❌ 否 |

把历史执行过算成本轮已覆盖，等于**拿过去给现在背书**——gate 会从"本轮有没有跑"悄悄变成"以前跑过没"，那正是假绿。所以：

- `identity` 单独一块，注释里写明不参与判定；`distinctPoints`（按 uid 去重）/ `executedPoints` / `neverExecutedPoints` / `reusedPoints`（本批次里历史出现过的）/ `newPoints` / `untrackedPoints`（无 uid，无法归并，单列不推测）；
- `history` **只算本次运行之前**。把当前运行算进来，`lastRunId` 永远等于当前 run，等于没回答"上一轮跑过没有"；
- `history.lastStatus` 取该 run 内多条用例的**最坏**结论（failed > blocked > skipped > passed），与 `readCoverage` 逐点收敛的口径一致。不能"最后一条用例 passed 就算 passed"。
- 取「每个 run 的最新一批」：同一 run 内改设计会追加 revision，旧 revision 的点与用例都还在表里，一起算会把"改了三次描述"数成三个测试点——而这正是 uid 要消灭的噪声。

`TestPointView.pointUid` 也顺带暴露：设计视图能直接看到身份，不必等覆盖率。

## 6. 验收

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `test/point-uid-identity.test.ts` | 8 | uid 规则（同值/归一化/改字变/需求引用不含 revision/执行证据不参与）、撞 uid 两分、迁移加列+回填+索引、幂等、回滚 |
| `test/qa-point-uid.test.ts` | 2 | 跨批次同 uid（改风险不换身份、改描述换身份）、批次内重复 → `duplicate_point`、缺陷挂点、跨批次并集、覆盖率 `identity`/`history` |
| `test/qa-quality-traceability.test.ts` | 8 | 既有回归全绿（覆盖率与缺陷语义未被改动） |

合计 18 例通过；`tsc --noEmit` 干净；相邻回归 `qa-integration` / `qa-task-run-registry` / `qa-task-run-migration` 35 例通过。

实测断言里刻意钉住的两条：第一轮运行的 `history` 全零（本次不算历史）；第二轮 `identity.reusedPoints=3 / newPoints=0`（同一批点被认成旧的），同时 `TP-003` 两轮都设计过、一次没跑（`history.executedRuns=0`）——这就是覆盖率假绿的来源，现在能看见。

## 7. 未做（明确留下）

1. **漏测回流未接线**。G4 原计划含"漏测/地图增量回流"，但**没有数据源**：当前库中 `qa_exploration_hypotheses` / `verdicts` 为 0 行，探索回写尚未产生假设层（见 `output/exploration-gap-analysis.md` 的 B2）。用户本轮确认范围是 `uid + 缺陷挂点 + 覆盖率`，回流不在其中。
2. **地图增量回流**同理：`maps_hash` 已有（G9），但"地图变了 → 哪些测试点该补"需要把 maps 差异映射到需求条目，缺映射数据。
3. **前端未展示** `pointUid` / `history` / `identity`。按界面迭代铁律，改 UI 前先出原型确认，本轮只做数据层。
4. **报告未引用**这些字段：`qa_report_indexes.coverage_json` 会自然带上新字段（整块序列化），但报告模板没有为"历史复发"单列一节。
5. 缺陷 `relatedPoints` 的**查询侧**未做：可以按 uid 反查"挂在这个点上的所有缺陷"，目前只能在缺陷视图里读到数组。索引建在 `qa_test_points(project_id, point_uid)`，缺陷侧要按 JSON 数组过滤，属下一步。
