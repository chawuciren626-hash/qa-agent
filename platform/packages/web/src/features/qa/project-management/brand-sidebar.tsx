/**
 * 品牌态侧栏（外壳状态 A：项目管理层）。
 *
 * 按《应用外壳两态布局设计规格》§3 与交互原型 `prototype/app-shell-two-states.html` 实现：
 * 自上而下只有品牌块（logo + AITestHarness + 副文字）、「项目管理」导航项（激活态）、
 * 底部账号区；不出现新建任务/项目视图/定时任务/项目资料/工作空间任何一项。
 *
 * 系统管理入口按规格收纳在底部头像菜单——当前账号菜单复用共享 UserMenu；
 * 「系统管理」行依赖管理端入口配置，接入前仅保留 TODO 标注（规格 §3.1）。
 */
import { useLocation, useNavigate } from "react-router";
import { GlyphIcon, ICONS } from "@prismshadow/penguin-ui";
import { UserMenu } from "../../../components/layout/user-menu";
import { useAuth } from "../../../state/auth";
// 品牌徽标与产品侧共用同一资源（penguin/ui/aith-logo.svg：#185FA5 底 A 字徽标 + #5DCAA5 对勾横杠）。
import brandLogo from "../../../../../../../penguin/ui/aith-logo.svg?url";
import "./project-management.css";

export function QaBrandSidebar({ onCollapse }: { onCollapse?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuth();
  const onProjects = location.pathname === "/qa/projects";
  const accountName = user?.displayName ?? user?.userId ?? "";
  return (
    <div className="qa-sidebar qpm-brand-side">
      {/* 品牌块：状态 A 不可点击（无副作用），仅作产品标识 */}
      <div className="qpm-brand">
        <img className="qpm-brand-logo" src={brandLogo} alt="AITestHarness Logo" />
        <div className="qpm-brand-text">
          <b>AITestHarness</b>
          <small>软件测试智能体平台</small>
        </div>
        {onCollapse && (
          <button type="button" className="qpm-brand-collapse" aria-label="收起侧栏" onClick={onCollapse}>
            <GlyphIcon d={ICONS.chevronLeftPipe} size={15} />
          </button>
        )}
      </div>
      <nav className="qpm-brand-nav" aria-label="项目管理导航">
        <button
          type="button"
          className={`qpm-nav-item${onProjects ? " is-active" : ""}`}
          aria-current={onProjects ? "page" : undefined}
          onClick={() => navigate("/qa/projects")}
        >
          <GlyphIcon d={ICONS.folder} size={16} decor="nav" />
          项目管理
        </button>
      </nav>
      {/* 底部账号区：头像菜单内含账号设置/退出；系统管理入口待接入（TODO） */}
      {/* TODO(Codex 联调)：系统管理入口收纳进头像菜单，需管理端入口配置 */}
      <div className="qpm-brand-foot">
        <UserMenu
          className="qpm-brand-account"
          menuClass="w-56"
          portal={{ direction: "up", align: "left" }}
          trigger={({ open, toggle }) => (
            <button
              type="button"
              className="qpm-brand-account-trigger"
              aria-expanded={open}
              aria-label={`账号：${accountName}`}
              onClick={toggle}
            >
              <span className="qpm-brand-avatar" aria-hidden="true">{[...accountName][0]?.toUpperCase() ?? "?"}</span>
              <span className="qpm-brand-who">
                <b>{accountName || "未登录"}</b>
                <small>账号与设置</small>
              </span>
            </button>
          )}
        />
      </div>
    </div>
  );
}
