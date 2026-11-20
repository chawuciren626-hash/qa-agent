# P-探索切片：全站模式落地（2026-11-20）

commit `bb07c70`。触发：用户发现探索快照（`doc-explore-<env>` 项目资料）内容薄——路由清单 10 页里只有管理起点 1 页「已渲染 · 18 控件」，其余全部「仅路由·0 控件」；并明确决策：**探索应该在建立项目时登录进去把所有页面探完**，这是给项目后续测试任务打底的参考资料。

## 为什么此前只有一页

探索链路（`explore-authenticated.mjs` → `merge-explore-maps.py` → 四层知识/B1 联动）每轮只采 `--target-url` 一个页面；合并脚本的 `_build_meta.note` 自己写着「其余页面仅有路由、控件清单为空（未建档）」。数据没坏：第 10/11 轮确实登录成功、采到 18 控件 · 3 表格 · 4 接口——薄是模式使然，不是故障。

## 本切片行为

- **`--mode site`（authenticated 探索默认；公开页保持单页口径）**：
  1. 目标页先行（pathname 校验、截图、结构采集，行为与旧版一致）；
  2. 路由清单 = DOM 同源链接（菜单/侧边栏）+ **JS bundle 路由表**（与 `explorer.extract_routes` 同源的正则：vue-router `path:`、`router.push`、`href=` 等，零 token）+ 目标页，前缀过滤（只采本应用首段路由下）、去重、**硬预算 50 页**（§15.1：预算是工程的护栏不是模型自觉）；
  3. 逐页 goto → pathname 校验（被重定向=权限墙/改版，如实记 `redirected:<path>` 不采结构）→ 结构采集 → 截图；单页失败记 reason 后继续，**全部没采到才判轮次失败**；
  4. 进度实时进「采集页面」步骤 detail（`全站 k/N · 路由`），UI 现有步骤条直接显示，前端零改动；
  5. 纪律：参数模板（`:id`）不字面访问；登录页不重复采（访问墙知识层已覆盖）；产物 `pages.json`（多页）+ `structure.json`（目标页，兼容旧口径）+ `explore-receipt.json`（mode/pages_total/pages_ok/pages_failed）。
- **`merge-explore-maps.py --pages`**：每个 ok 页走引擎 `extract_controls` 登记 `controls_by_page`；`routes = 菜单兜底 ∪ 实际采过的页`（采过的页面不因菜单树缺失而丢登记）；`_build_meta` 标注 mode 与失败页原因；**单页口径行为不变**。
- **服务端**：spawn 加 `--mode site`（authenticated 时）；`pythonMerge` 探测 `pages.json` 存在则追加 `--pages`；summary 增 `mode` / `pagesOk` / `pagesFailed`。

## 验收

- `smoke_merge_explore_pages.py` 10 断言全过：多页逐页登记 / 失败页不冒充已渲染 / meta 记录失败原因 / 单页兼容（只登记 target）。
- `project-exploration.test.ts` 13 例全过（+1 全站用例：mode/pagesOk=2/pagesFailed=1、步骤 detail「2/3 页」、知识层）。typecheck 干净。
- 引擎脚本无浏览器单测——真机验收走一轮真实探索：路由清单页数应接近 bundle 路由数，项目资料快照应出现多个「已渲染 · N 控件」。

## 边界与后续

- 逐页快照仍「只采结构与本页接口」——跨页业务流程/状态迁移（flow 层）依旧不给，不冒充。
- 呈现层（项目资料页的「人读版」：路由表/接口表/探索度指标）待原型确认，本切片未动 web。
- 部署：引擎运行时重新打包 + server 重构建；web 未动。
