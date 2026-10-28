import { afterEach, expect, it, vi } from "vitest";
import { syncAccountScope } from "../src/lib/account-scope";
afterEach(()=>vi.unstubAllGlobals());
it("preserves and restores local drafts across central account switches",async()=>{
  const storage: Record<string,string> = {"penguin.installId":"installation-a","penguin.draft":"owner-private-draft","penguin.theme":"dark"};
  Object.defineProperties(storage,{
    getItem:{value:(key:string)=>storage[key]??null},
    setItem:{value:(key:string,value:string)=>{storage[key]=value;}},
    removeItem:{value:(key:string)=>{delete storage[key];}},
  });
  vi.stubGlobal("localStorage",storage);
  let userId="acct_ordinary";
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>Response.json(url.endsWith("config")?{enabled:true}:{user:{userId}})));
  expect(await syncAccountScope()).toBe(true);
  expect(storage["penguin.draft"]).toBeUndefined();
  expect(storage["penguin.installId"]).toBe("installation-a");
  storage["penguin.draft"]="ordinary-private-draft";
  userId="admin";
  expect(await syncAccountScope()).toBe(true);
  expect(storage["penguin.draft"]).toBe("owner-private-draft");
  expect(storage["penguin.theme"]).toBe("dark");
  userId="acct_ordinary";
  expect(await syncAccountScope()).toBe(true);
  expect(storage["penguin.draft"]).toBe("ordinary-private-draft");
  expect(await syncAccountScope()).toBe(false);
});
it("does not change local drafts when central identity cannot be verified",async()=>{
  const store={getItem:vi.fn(),setItem:vi.fn(),removeItem:vi.fn()};
  vi.stubGlobal("localStorage",store);
  vi.stubGlobal("fetch",vi.fn(async(url:string)=>url.endsWith("config")?Response.json({enabled:true}):new Response(null,{status:503})));
  expect(await syncAccountScope()).toBe(false);
  expect(store.setItem).not.toHaveBeenCalled();expect(store.removeItem).not.toHaveBeenCalled();
});
