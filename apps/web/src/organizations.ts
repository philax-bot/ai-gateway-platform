import type { Organization } from '@ai-gateway/contracts';

export function organizationTree(organizations:Organization[],id:string){
  const ids=new Set([id]),pending=[id];
  while(pending.length){const parentId=pending.pop()!;for(const o of organizations)if(o.parentId===parentId&&!ids.has(o.id)){ids.add(o.id);pending.push(o.id);}}
  return ids;
}
export function organizationPath(organizations:Organization[],id:string){
  const names:string[]=[],visited=new Set<string>();let current=organizations.find(o=>o.id===id);
  while(current&&!visited.has(current.id)){visited.add(current.id);names.unshift(current.name);current=organizations.find(o=>o.id===current!.parentId);}
  return names.join(' / ')||id;
}
export function organizationEnabled(organizations:Organization[],id:string){
  const visited=new Set<string>();let current=organizations.find(o=>o.id===id);
  while(current&&!visited.has(current.id)){if(!current.active)return false;visited.add(current.id);if(!current.parentId)return true;current=organizations.find(o=>o.id===current!.parentId);}
  return false;
}
