# 2026-11-24 单实例部署与双库迁移记录

> 后续纠正：下文“本机安装版”是当时实际执行记录，不代表当前目标架构。当前客户端须直连统一服务端，部署步骤以 `remote-client-deployment-20261124.md` 为准；不得再把 59764 的完整业务 Server 当作必须运行的客户端底座。

状态：虚拟机与本机安装版已更新；源码工作区未提交、未推送。构建输入为本地 `main`（`5ffe02208e95f1c228acb4f3b35672ee1dc3e42e` 加工作区改动），不应将该 SHA 单独当作已部署源码版本。

部署前重新生成 `platform/packages/server/src/ifaces.json` 后，sync 路由的授权值为 `none`，旧 `public` 值属于陈旧生成文件；相关服务端回归 80/80、单实例/登录复测 4/4 通过，server/web/desktop 类型检查与构建通过。

## 虚拟机

- 原 18776 业务库 `data/host/web.db` 为事实库，原 18777 管理库 `data/central-host/web.db` 提供账号、公共资源、模型目录和管理助手。两个旧进程正常退出后，完整 `data/` 与旧 server/web 产物冷备到 `/home/agent/aitest-main-21254a2/backups/single-instance-20261124/final-20261124T014909Z/`；3164 个备份文件 SHA256 校验通过。
- 从冷备分别用 SQLite backup API 生成最终快照，目标版本 `migrate-db.js` 对两库各应用 `2026-11-23-account-identity-direct`。合库报告在 `output/release/single-instance-20261124/merge-report.json`，原始报告也在 VM 备份目录。两个有效旧身份映射转为中央用户 ID；两个已不存在的中央用户对应旧身份保留。
- 合库后 `users=6`、`projects=6`、`qa_tasks=5`、真实 `platform_task_links=2`、`public_resources=59`、`public_resource_versions=105`、迁移账本 46 条。`integrity_check=ok`，外键错误 0；中央模型密钥可解密原配置（6 个 provider）。管理助手目录、中央 Agent 文件和对应加密密钥已迁入业务数据根。
- 唯一应用进程由 `systemctl --user` 的 `aitest-unified.service` 管理，监听 18777，数据根为 `data/host`，不设置 `AITEST_ACCOUNT_CENTER*`。已启用用户服务 linger。旧 `central-host` 及旧 launcher 状态移入备份目录的 `retired-live-layout/`；18776 socket 服务已停用，VirtualBox 的 `aitest-user` 端口转发已删除。
- `http://localhost:18777/admin`、`/user`、两端登录页及静态资源均返回 200。隔离最终快照用临时会话验收了任务平台设置、接收人、用户管理、模型配置接口（均 200）；正式服务的用户与模型接口亦返回 200。正式库未插入测试会话。原管理员密码未重置，也未使用真实账号进行浏览器登录验收。

虚拟机回滚所需的原始双库、WAL、项目目录、原 server/web 产物、启动环境均保存在上述备份目录。回滚时先停止 `aitest-unified.service`，再恢复**同一备份中的程序与整个数据目录**；不能只恢复其中一个数据库。原启动环境分别在备份中的 `central-launch-env.json` 和 `business-launch-env.json`（含凭据，权限 0600），不得提交。恢复双端口还需重新启用 18776 用户 socket，并在 VirtualBox 恢复对应 NAT 转发。回滚前后均须重新核对业务写入，不能覆盖切换后的新数据。

## 本机安装版

- 实际安装根是 `E:/AITestHarness/installed`。桌面连接数为 0，官方 `local-service pause` 成功后，备份旧数据库、账号服务配置、密钥和管理助手目录到 `E:/AITestHarness/backups/single-instance-local-20261124/`，数据库哈希核对一致。
- `deploy-project-management-local.mjs` 同步 server/main/migrate-db/web；脚本生成程序备份 `E:/AITestHarness/backups/project-management-2026-11-24T02-05-14-901Z/`，完整性清单验证通过（1133 个应用文件、470 个引擎文件）。目标迁移显式应用 1/46 条，随后官方 `resume` 成功，服务 `ready=true`、端口 59764、桌面连接数 0。
- 安装产物 SHA256 与本轮构建一致。`/admin/login`、`/user/login`、`/admin/task_platform` 及首页 JS 均返回 200。数据库 `integrity_check=ok`、外键错误 0，用户 9、项目 12、QA 任务 20 均保留。原有 5 条 `platform_task_links` 全部是 `demo`，被新迁移清除；正式平台任务并未因此丢失。
- 本机 `account-center.json` 仍指向 `http://localhost:18777`，现为统一 VM 服务地址。该文件保留给现有客户端连接逻辑，不能再理解为独立账号中心实例。

## 尚未验收与后续问题

- 未用真实管理员密码验收登录和配置写入。VM 管理员账号仍处于初始密码状态，服务启动日志提示可通过一次性 claim 链接设置密码；部署过程未重置密码，链接属于凭据，不在文档中记录。未连通真实任务平台执行 ping、手动同步和客户端镜像拉取。VM 当前模型目录有 6 个渠道但 0 个模型；可用模型与凭据需由管理员配置。
- ZCode 清单明确标注阶段 C 的测试结果回传闭环尚未接线；客户端同步 service key 的管理端获取/配置入口也未交付。部署没有替这些功能写临时业务补丁，真实联调需要另行完成。
- 本轮只部署并验证现有代码与数据迁移；未进行 Git 提交、合并或推送。
