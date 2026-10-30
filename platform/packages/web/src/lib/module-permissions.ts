export function allowedModule(user:{isAdmin:boolean;modulePermissions?:string[];menuKeys?:string[]}|null|undefined,key:string):boolean {
  if (!user) return false;
  if (!user.isAdmin && user.menuKeys && ["agents","models","plugins","skills"].includes(key) && !user.menuKeys.includes(key)) return false;
  return key==="models"||user.isAdmin||user.modulePermissions===undefined||user.modulePermissions.includes(key);
}
export function pageModule(path:string,search=""):string|undefined {
  if(path==="/chat"||path.startsWith("/chat/")) {
    const view=new URLSearchParams(search).get("view");
    return view==="library"?"library":view==="schedules"?"schedules":"chat";
  }
  if(path.startsWith("/qa/library"))return "library";
  if(path.startsWith("/qa/project"))return "projects";
  return ["agents","models","plugins","skills","machines","usage","benchmark"].find(key=>path===`/${key}`||path.startsWith(`/${key}/`));
}
