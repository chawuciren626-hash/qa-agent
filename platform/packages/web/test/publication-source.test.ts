import { describe, expect, it } from "vitest";
import { agentPublication, modelPublication, pluginPublication } from "../src/features/admin/publication-source";
describe("explicit publication projections", () => {
  it("does not copy model credentials, masks, environment settings or private connection metadata", () => {
    const result=modelPublication({provider:"custom",modelId:"qa",displayName:"QA",effective:{baseUrl:"https://example.com/v1",clientType:"openai-chat",apiKeyMasked:"secret-mask"},credential:{apiKey:"secret",apiKeyMasked:"secret-mask"},envKey:"PRIVATE_ENV",contextWindow:32000} as any);
    expect(result.payload).toMatchObject({baseUrl:"https://example.com/v1",clientType:"openai-chat",contextWindow:32000});
    expect(JSON.stringify(result)).not.toMatch(/secret|PRIVATE_ENV|credential/);
  });
  it("publishes only selected agent text and runtime limit, not the full state or tool credentials", () => {
    const result=agentPublication({agentId:"qa",name:"QA"} as any,{agentsMd:"# Public",stateDir:"private-directory",systemConfigYaml:"secret",config:{systemPrompt:"Public prompt",maxTurns:20,vault:{secret:"value"},mcpServers:[{env:{KEY:"secret"}}]}} as any);
    expect(result.payload).toMatchObject({agentsMd:"# Public",prompt:"Public prompt",maxTurns:20});
    expect(JSON.stringify(result)).not.toMatch(/secret|private-directory|vault|mcpServers/);
  });
  it("references upstream plugins without recreating their skills, hooks or MCP implementations", () => {
    const result=pluginPublication({name:"qa-plugin",title:"QA",version:"1.0.0",skills:[{name:"skill"}],mcpServers:[{env:{KEY:"secret"}}]} as any);
    expect(result.payload).toEqual({pluginName:"qa-plugin",pluginVersion:"1.0.0",source:"upstream-library"});
  });
});
