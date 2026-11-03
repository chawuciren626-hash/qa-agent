import { QaPersonalResources } from "./personal-resources";
import "../plugins/plugin-market.css";

export function PersonalSkillsPage() {
  return <main className="qa-plugin-market mx-auto h-full max-w-5xl overflow-auto p-6" aria-label="我的技能">
    <QaPersonalResources />
  </main>;
}
