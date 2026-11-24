/**
 * 侧栏「全部项目」模式的会话数据。
 *
 * 侧栏自己的 Sessions store 是**单 Project 作用域**：分页游标、实时状态、机器缓存、
 * 增删改的乐观更新全部按「当前项目」算。把它改成多项目命名空间会波及 chat 页的路由解析
 * 与实时状态订阅，回归面远超这个需求本身。
 *
 * 所以这里另起一条**只读索引**：服务端按 Access 的可访问项目清单聚合 active 会话
 * （口径与侧栏一致，见 `/api/me/session-index`），前端只负责展示与跳转。写操作仍然由
 * 打开会话之后的正常链路承担——点某一行会先把当前项目切过去，页面才进入它。
 */
import { useCallback, useEffect, useState } from "react";
import { getSessionIndex, type MeSessionIndexItem } from "../api/endpoints";

const ENABLED_KEY = "aitest.sidebar.all-projects";
/** 索引是只读快照：一分钟对齐一次足够，侧栏不承担「实时」。 */
const POLL_MS = 60_000;
const LIMIT = 80;

/** 默认开启：会话列表本就不该被「项目管理里点开哪个项目」筛掉。用户手动切回单项目会记住。 */
function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

export interface AllProjectSessions {
  /** 是否处于「全部项目」模式。关闭时侧栏按原逻辑只列当前项目。 */
  enabled: boolean;
  toggle: () => void;
  items: MeSessionIndexItem[];
  loading: boolean;
  error: string;
  refresh: () => void;
}

export function useAllProjectSessions(): AllProjectSessions {
  const [enabled, setEnabled] = useState(readEnabled);
  const [items, setItems] = useState<MeSessionIndexItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /** 手动/轮询刷新：改这个值让下面的 effect 重新取一次。 */
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!enabled) {
      setItems([]);
      setError("");
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    void getSessionIndex(LIMIT)
      .then((res) => {
        if (!alive) return;
        setItems(res.items);
        setError("");
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : "读取全部会话失败");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    const timer = setInterval(() => setNonce((n) => n + 1), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [enabled, nonce]);

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(ENABLED_KEY, next ? "1" : "0");
      } catch {
        // 存储不可用（隐私模式/配额满）：只在本次会话内生效，不阻断切换。
      }
      return next;
    });
  }, []);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  return { enabled, toggle, items, loading, error, refresh };
}
