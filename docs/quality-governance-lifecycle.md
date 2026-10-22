# 质量治理闭环

## 事实与处置分离

`defects/defect-records.json` 保存某次执行的原始观察，`defects/lifecycle.json` 保存后续审阅、修复声明与复测事件。不能为了关闭问题修改原始失败结果，重复规范化不能清空或覆盖既有台账。首次状态只允许 draft 或 needs_review；模型写入的 confirmed、fixed、closed 不构成有效处置。

记录以来源 invocation_id 和 defect_id 定位。事件包含顺序、原/新状态、操作者声明、原因、依据文件哈希和前序事件哈希。读取时重放校验原始归档、事件链与依据文件，损坏或变更会阻断可信报告。

## 状态与前提

| 当前状态 | 操作 | 结果与限制 |
| --- | --- | --- |
| draft / needs_review | confirm | 有审阅依据并指定明确分类后进入 confirmed |
| draft / needs_review | reject | 有依据后进入 rejected，保留历史 |
| confirmed | fixed | 记录修复声明，尚未验证修复有效 |
| fixed | retest | 关联用例全部通过才 closed；出现失败回到 confirmed |
| closed | retest | 新的合格复测失败可重新打开；不重复登记无变化的通过 |

每次变更需要当前 revision、actor、reason 和本运行内真实依据文件。revision 防止使用旧状态覆盖新审阅，独占锁防止并发写入。actor 是可追溯声明，不是登录认证或人工审批的密码学证明。Agent 应取得明确分类/修复依据，不得自行冒充审阅人。

## 命令示例

以下参数均为占位符，需替换为实际运行与证据。依据文件应先归档进该 run；逗号分隔多个路径。

```powershell
npm run quality:lifecycle -- show <run_id>
npm run quality:lifecycle -- confirm <run_id> --invocation=<origin_uuid> --defect=<defect_id> --revision=0 --actor=<reviewer> --reason=<review_reason> --evidence=inputs/review.md --category=product_defect
npm run quality:lifecycle -- fixed <run_id> --invocation=<origin_uuid> --defect=<defect_id> --revision=1 --actor=<reviewer> --reason=<fix_reason> --evidence=inputs/fix.md
npm run quality:lifecycle -- retest <run_id> --invocation=<origin_uuid> --defect=<defect_id> --revision=2 --actor=<reviewer> --reason=<retest_reason> --evidence=inputs/retest-review.md --retest=<retest_uuid>
```

跨运行复测额外使用 `--retest-run=<run_id>`。不是只要用例 ID 一样就能关闭：复测必须为独立、封存、已结束的批次，启动时间晚于修复/上次事件，包含全部关联用例，批准设计文件哈希和计划中的用例投影一致，归档的环境配置引用路径及哈希一致。跳过、遗漏、旧复测和证据改写不能关闭。新环境配置即使内容相近也可能不满足上述严格条件，应重新评估，不得放宽检查伪造等价性。

真实复测仍须由总控按审批流程派发自动化执行 Agent；本命令只登记已有证据，不执行测试或修改产品。

## 报告与质量门

- 当前观察与历史未解决问题同时进入治理视图。后一次测试通过不自动关闭历史问题。
- fixed 是待验证修复；未解决产品问题、历史风险仍影响质量门。closed/rejected 保留历史但不继续作为未解决风险。
- 已完成报告对应的台账发生变化时，报告阶段变为 revision_requested，旧文件保留为历史。报告生成中禁止台账变更，避免并行生成不一致结论。
- 重新生成度量、Markdown、Word/PDF，再走报告产物契约和阶段登记；不要直接改 manifest。发布脚本不会把待重制报告列为当前有效报告。
- Word/PDF 导出器检查度量与台账哈希；完整证据重放由度量及阶段契约负责。导出成功本身不等于证据完整或版式验收通过。

## 聚合、兼容与恢复

指纹只产生同 scope_id 的重复候选；默认 scope 为 run_id。跨运行关联需要显式共享 scope，仍不自动合并身份、关闭缺陷或提交外部缺陷平台。索引遇到损坏运行跳过整次贡献并输出警告；趋势拒绝过期执行状态/台账的度量。

旧历史不补造审阅事件。缺少可验证台账的高级状态不能视为已确认治理。不可通过删除台账或重新规范化绕过检查。

进程异常退出可能留下 lifecycle.json.lock。先停止相关写入并确认没有活跃进程，保留锁、台账和审计副本，检查最后一次完整事件及报告状态，再由维护者恢复；禁止 Agent 遇锁自动删除重试。

本机制是本地工程完整性校验，不是操作系统隔离、签名防篡改存储或外部缺陷管理平台。具有工作区写权限的程序仍可绕过入口，后续应完善工具侧权限边界。
