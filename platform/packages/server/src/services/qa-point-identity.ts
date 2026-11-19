/**
 * 测试点的稳定身份（P6/G4）。
 *
 * 现状：测试点的身份是 `(batch_id, point_key)`——每个批次重新编号，所以同一件事在
 * 两个批次里可能是 `tp-1` 和 `tp-7`。于是"这条缺陷属于哪个测试点""这个测试点上一轮
 * 跑过没有""项目级到底覆盖了多少"三件事都得靠人肉比对标题，而靠人比对的结论不会积累。
 *
 * `point_uid` 就是一个**由内容算出来的**身份：同样的需求引用、模块、功能、描述，
 * 在哪一批、哪个 run 里都算出同一个值。
 *
 * 输入口径（用户 2026-11-19 确认）：
 *   需求引用 + 模块 + 功能 + 描述
 *
 * 为什么**不**包含 risk / coverageType / executionLayer / 验证方式：
 *   这些是设计过程中的**可调项**。把它们算进身份，等于"人调整一次风险等级，这个测试点
 *   就变成新的一条"——历史执行结果、缺陷归属全部断开，uid 也就失去了唯一价值。
 *
 * 为什么**要**包含需求引用：
 *   两个模块下描述字面相同的测试点（"登录失败提示正确"）是两件事。模块已经能分开大部分，
 *   但跨模块同名的边界点（"空输入校验"）必须靠需求来源区分。
 *
 * 归一化的边界（**只做不会改变语义的处理**）：
 *   - NFKC：全角/半角、兼容字符统一（"Ａ" 与 "A" 是同一个字）；
 *   - 折叠所有空白为一个空格并去首尾：排版差异不是设计变更；
 *   - 英文小写：大小写不改变测试点含义（中文不受影响）。
 *   **不做**同义词替换、不做标点删除、不做截断：那些会真的改变语义，把两个不同测试点
 *   算成一个。宁可"改一版措辞就算新测试点"，也不要"误合并两条不同的测试点"——
 *   前者是噪声，后者是错误。
 */
import { createHash } from "node:crypto";
import type { EvidenceRef } from "./qa-project-knowledge.js";

/** uid 的展示长度：取 sha256 前 32 位。足够避免碰撞，又不至于在表格里挤成一团。 */
export const POINT_UID_LENGTH = 32;

/** 归一化：只做无损处理（见文件头）。 */
export function normalizePointText(value: string): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

/**
 * 从证据引用里取「需求来源」标识。
 *
 * 只取 `documentId` 与 `ruleId`，**不取** revision/section/quote：
 * 需求文档升版、引用位置挪动，都不改变"这条测试点来自哪条需求"。
 * 若把 revision 算进来，文档每升一版所有测试点都会变成新身份——那等于没有身份。
 */
export function requirementRefsOf(evidenceRefs: readonly EvidenceRef[] | undefined): string[] {
  const refs = new Set<string>();
  for (const ref of evidenceRefs ?? []) {
    if (ref.type === "document" && typeof ref.documentId === "string" && ref.documentId) {
      refs.add(`document:${ref.documentId}`);
    } else if (ref.type === "rule" && typeof ref.ruleId === "string" && ref.ruleId) {
      refs.add(`rule:${ref.ruleId}`);
    }
  }
  return [...refs].sort();
}

export interface PointIdentityInput {
  module: string;
  feature: string;
  description: string;
  evidenceRefs?: readonly EvidenceRef[];
}

/**
 * 算稳定身份。空字段照常参与（不跳过）：跳过会让"没有模块"与"模块是别的值"算出同一个
 * 结果，那是把缺失当成值。
 */
export function pointUid(input: PointIdentityInput): string {
  const parts = [
    requirementRefsOf(input.evidenceRefs).join("\u001f"),
    normalizePointText(input.module),
    normalizePointText(input.feature),
    normalizePointText(input.description),
  ];
  return createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex").slice(0, POINT_UID_LENGTH);
}

/**
 * 同一批次内出现相同 uid 时的判断：描述完全一致 → 重复设计（应当合并）；
 * 描述不同而 uid 相同 → 归一化把它们拉平了（例如只差大小写），必须报出来让人修改描述，
 * 不能悄悄合并。返回 `null` 表示无需处理。
 */
export function duplicatePointReason(left: PointIdentityInput, right: PointIdentityInput): "identical" | "normalized_collision" | null {
  if (pointUid(left) !== pointUid(right)) return null;
  const identical = normalizePointText(left.description) === normalizePointText(right.description);
  return identical ? "identical" : "normalized_collision";
}
