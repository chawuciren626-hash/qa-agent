/**
 * The account menu, shared by both avatars that open one: the pinned sidebar's user row and
 * the collapsed rail's avatar. One component rather than a copy per anchor — the rows
 * (Settings and sign out) and the dialog behind the first of them must
 * stay the same menu from either side, and a second copy is how two menus drift apart.
 *
 * Only the trigger differs, so the trigger is the caller's: it is handed the menu's own open
 * state, which is what keeps "what opening means" here rather than in two places.
 *
 * The settings dialog is mounted OUTSIDE the panel: the panel's children unmount the moment
 * the menu closes, and the settings row closes the menu as it opens the dialog.
 *
 * The sidebar trigger carries the account identity; the menu contains actions only.
 */
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ConfirmModal,
  Dropdown,
  Menu,
  MenuItem,
} from "@prismshadow/penguin-ui";
import type { DropdownPortal } from "@prismshadow/penguin-ui";
import { S } from "../../lib/strings";
import { useAuth } from "../../state/auth";
import { SettingsDialog } from "../../features/settings/settings-dialog";
import { onSettingsRequest } from "../../features/settings/settings-request";
import type { SettingsSectionKey } from "../../lib/settings-sections";
import { isDesktopShellWindow } from "../../lib/account-menu";
import { apiErrorText } from "../../lib/api-error";
import { ChangePasswordDialog } from "../account/change-password-dialog";

export function UserMenu({
  trigger,
  menuClass,
  portal,
  anchorRect,
  anchorOwner,
  className,
}: {
  /** The anchor's own look, wired to this menu's state: the sidebar's full-width row, the rail's avatar. */
  trigger: (state: { open: boolean; toggle: () => void }) => ReactNode;
  /** Panel size and, for an in-flow panel, its docking direction (see Dropdown). */
  menuClass?: string;
  /** Escape the anchor's clipping box by rendering the panel through a body portal. */
  portal?: DropdownPortal;
  /** Place the panel against this viewport box instead of the anchor's own — the rail hangs its menu off the rail's outer edge rather than over the rail. */
  anchorRect?: { top: number; bottom: number; left: number; right: number } | null;
  /** The element `anchorRect` was measured from, so only a scroll that moved it dismisses the panel. */
  anchorOwner?: () => HTMLElement | null;
  /** Extra classes for the anchor container (e.g. `mt-auto` in a flex column). */
  className?: string;
}) {
  const navigate = useNavigate();
  const { user, logout, desktopMode, sessionVia, accountClient } = useAuth();
  const canOpenWebAdmin = accountClient && user?.isAdmin && !isDesktopShellWindow({ desktopMode, sessionVia });
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** The page a request asked for; the menu's own row asks for none (the viewer's first). */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionKey | undefined>(undefined);
  const [confirmingLogout, setConfirmingLogout] = useState(false);
  const [settingLoginPassword, setSettingLoginPassword] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const [adminViewError, setAdminViewError] = useState("");

  const prepareLogout = () => {
    setOpen(false);
    setLogoutError("");
    if (!accountClient && user?.passwordIsInitial && isDesktopShellWindow({ desktopMode, sessionVia })) {
      setSettingLoginPassword(true);
    } else {
      setConfirmingLogout(true);
    }
  };

  const confirmLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    setLogoutError("");
    try {
      await logout();
      navigate("/login", { replace: true });
    } catch (error) {
      setLogoutError(apiErrorText(error));
    } finally {
      setLoggingOut(false);
    }
  };

  const openAdminView = async () => {
    setOpen(false);
    setAdminViewError("");
    // The desktop host and the central admin site use separate origins and sessions.
    // Resolve the configured origin from the host instead of opening its local /admin route.
    try {
      const response = await fetch("/api/account-client/config", { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error("无法读取管理服务地址。");
      const config = await response.json() as { enabled?: boolean; origin?: string };
      if (!config.enabled || !config.origin) throw new Error("管理服务尚未配置。");
      const origin = new URL(config.origin);
      if (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) throw new Error("管理服务地址无效。");
      const adminUrl = new URL("/admin/login", origin);
      adminUrl.searchParams.set("returnTo", new URL("/user/", window.location.origin).href);
      window.location.assign(adminUrl.href);
    } catch (cause) {
      setAdminViewError(cause instanceof Error ? cause.message : "无法打开管理员视图。");
      setOpen(true);
    }
  };

  // Settings can be asked for from outside this menu (see settings-request.ts): the request
  // opens the same dialog, on the page it names.
  useEffect(
    () =>
      onSettingsRequest(({ section }) => {
        setSettingsSection(section);
        setSettingsOpen(true);
      }),
    [],
  );

  return (
    <>
      <Dropdown
        open={open}
        setOpen={setOpen}
        button={trigger({ open, toggle: () => setOpen(!open) })}
        {...(className !== undefined ? { className } : {})}
        {...(menuClass !== undefined ? { menuClass } : {})}
        {...(portal !== undefined ? { portal } : {})}
        {...(anchorRect !== undefined ? { anchorRect } : {})}
        {...(anchorOwner !== undefined ? { anchorOwner } : {})}
      >
        <div className="py-1">
          {/* Settings dialog: everyone gets the row — the dialog always has the
              personal pages, and the server-global ones inside it stay gated by the
              section registry rather than by this row. The preference rows that used to
              stack here live on its pages now. */}
          <Menu>
            {canOpenWebAdmin && <div className="px-3.5 py-1 text-xs text-gray-500 dark:text-gray-400">当前：用户视图</div>}
            {canOpenWebAdmin && <MenuItem label="管理后台" onSelect={() => { void openAdminView(); }} />}
            <MenuItem
              label={S.settings.title}
              onSelect={() => {
                setOpen(false);
                setSettingsSection(undefined);
                setSettingsOpen(true);
              }}
            />
            <MenuItem danger onSelect={prepareLogout} label={S.auth.logout} />
          </Menu>
          {adminViewError && <p role="alert" className="px-3.5 py-1 text-xs text-red-600">{adminViewError}</p>}
        </div>
      </Dropdown>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        {...(settingsSection !== undefined ? { section: settingsSection } : {})}
      />
      <ChangePasswordDialog
        open={settingLoginPassword}
        onClose={() => setSettingLoginPassword(false)}
        firstDesktopLogout
        onSaved={() => setConfirmingLogout(true)}
      />
      {/* Signing out is confirmed first: the row sits in a menu of harmless entries, and a
          slip would end the session and land on the login page. Mounted beside the settings
          dialog, outside the dropdown, so it outlives the menu that opened it. */}
      <ConfirmModal
        open={confirmingLogout}
        title={S.auth.logoutConfirmTitle}
        confirmLabel={S.auth.logout}
        cancelLabel={S.common.cancel}
        busy={loggingOut}
        onClose={() => { if (!loggingOut) setConfirmingLogout(false); }}
        onConfirm={() => void confirmLogout()}
      >
        <p className="text-sm text-gray-600 dark:text-gray-300">{S.auth.logoutConfirmBody}</p>
        {logoutError && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{logoutError}</p>}
      </ConfirmModal>
    </>
  );
}
