import { PluginsPage } from "../plugins/plugins-page";
import { ProjectProvider } from "../../state/project";
import { MachinesProvider } from "../../state/machines";
import { SessionsProvider } from "../../state/sessions";
import { CompanyProvider } from "../../state/company";

/** The management shell omits runtime providers; upstream installs need their scoped state. */
export function CentralPluginsPage() {
  return <ProjectProvider scope="admin">
    <MachinesProvider><SessionsProvider><CompanyProvider>
      <PluginsPage managedAdmin />
    </CompanyProvider></SessionsProvider></MachinesProvider>
  </ProjectProvider>;
}
