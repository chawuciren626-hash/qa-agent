import {expect,it} from "vitest";
import {initialDraft,providerEditingView,providerSettingsUpdate} from "../src/features/models/provider-settings-dialog";
it("echoes common model settings and renames without materializing inherited settings",()=>{
 const view=providerEditingView(undefined,[{modelId:"model",clientType:"openai-chat",originalBaseUrl:"https://example.com/v1"}],"Gateway");
 expect(view.baseUrl).toBe("https://example.com/v1");expect(view.clientType).toBe("openai-chat");expect(view.displayName).toBe("Gateway");
 expect(providerSettingsUpdate(view,initialDraft(view))).toBeNull();
 expect(providerSettingsUpdate(view,{...initialDraft(view),displayName:"New Gateway"})).toEqual({displayName:"New Gateway"});
});
it("keeps explicit settings and does not choose an arbitrary model endpoint",()=>{
 const rows=[{modelId:"a",clientType:"openai-chat",originalBaseUrl:"https://a.example/v1"},{modelId:"b",clientType:"ant-messages",originalBaseUrl:"https://b.example/v1"}];
 expect(providerEditingView(undefined,rows,"Mixed").baseUrl).toBeUndefined();
 expect(providerEditingView(undefined,rows,"Mixed").clientType).toBeUndefined();
 expect(providerEditingView({displayName:"Saved",baseUrl:"https://group.example",clientType:"mmsp"},rows,"Builtin")).toMatchObject({displayName:"Saved",baseUrl:"https://group.example",clientType:"mmsp"});
});
