/** Keep each identity's browser drafts/preferences local, and restore them before App mounts. */
if (typeof window !== "undefined") window.addEventListener("storage", event => {
  if (event.key === "aitest.ui.activeUser" && event.newValue !== event.oldValue) location.reload();
});
export async function syncAccountScope(): Promise<boolean> {
  const config=await fetch("/api/account-client/config",{signal:AbortSignal.timeout(6000)});
  if (!config.ok || !(await config.json()).enabled) return false;
  const response=await fetch("/api/me",{credentials:"same-origin",signal:AbortSignal.timeout(6000)});
  if (!response.ok) return false;
  const {user}=await response.json() as {user:{userId:string}};
  const marker="aitest.ui.activeUser";
  const before=localStorage.getItem(marker) ?? "admin";
  if(before===user.userId) {localStorage.setItem(marker,user.userId);return false;}
  const keys=Object.keys(localStorage).filter(k=>k.startsWith("penguin.") && k!=="penguin.installId");
  const current=Object.fromEntries(keys.map(k=>[k,localStorage.getItem(k)]));
  const scope=localStorage.getItem("penguin.installId")??"current";
  const saved=localStorage.getItem(`aitest.ui.${scope}.${user.userId}`);
  const restored=saved?JSON.parse(saved) as Record<string,string>:{};
  // Save before touching keys: a full browser store must never silently discard drafts.
  localStorage.setItem(`aitest.ui.${scope}.${before}`,JSON.stringify(current));
  for(const key of keys)localStorage.removeItem(key);
  for(const [key,value] of Object.entries(restored)) if(key.startsWith("penguin.") && key!=="penguin.installId" && typeof value==="string") localStorage.setItem(key,value);
  localStorage.setItem(marker,user.userId);
  return true;
}
