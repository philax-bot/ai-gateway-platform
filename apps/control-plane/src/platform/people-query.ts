import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import {hasOperationsAccess,type PersonQuery,type PersonScope,type PersonSummary,type PersonPage,type PersonOrganizationQuery,type PersonOrganizationPage,type WorkspaceState} from '@ai-gateway/contracts';
import {activeMember,operator,pick,strings} from './validation';

type State=Pick<WorkspaceState,'members'|'organizations'|'projects'>;
const scopes:PersonScope[]=['directory','onboarding','manager','owner','sponsor','project-members','project-allocation'];
function context(s:State,actorId:string,input:{scope:PersonScope;projectId?:string}){
  if(!input||typeof input!=='object'||!scopes.includes(input.scope))throw new BadRequestException('invalid person selection scope');
  const actor=activeMember(s,actorId),admin=hasOperationsAccess(actor);
  if(input.scope==='onboarding'||input.scope==='sponsor')operator(actor,'administration.manage');
  let project:State['projects'][number]|undefined;
  if(input.scope==='project-members'||input.scope==='project-allocation'){
    project=pick(s.projects,input.projectId,'project');
    if(!actor.roles.includes('operator')&&project.managerId!==actor.id)throw new ForbiddenException('project manager responsibility required');
    if(project.status!=='active')throw new ConflictException('项目当前不可调整成员或分配额度。');
  }
  const all=admin||!!project;
  const peers=new Set([actor.id]);
  if(!all)for(const p of s.projects.filter(p=>p.memberIds.includes(actor.id)||p.managerId===actor.id||p.applicantId===actor.id)){p.memberIds.forEach(id=>peers.add(id));peers.add(p.managerId);}
  const members=s.members.filter(m=>(all||peers.has(m.id))&&(input.scope!=='project-allocation'||project!.memberIds.includes(m.id)));
  return {members,project,all};
}
function paging(input:{page?:number;pageSize?:number}){const page=input.page??1,pageSize=input.pageSize??40;if(!Number.isSafeInteger(page)||page<1||page>1000000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)throw new BadRequestException('invalid person query page');return {page,pageSize};}
function search(value:unknown){if(value===undefined)return '';if(typeof value!=='string'||value.length>200)throw new BadRequestException('invalid person search');return value.trim().toLocaleLowerCase();}
function organizations(s:Pick<State,'organizations'>){
  const byId=new Map(s.organizations.map(o=>[o.id,o])),children=new Map<string|null,State['organizations']>(),paths=new Map<string,{path:string;valid:boolean}>();
  for(const o of s.organizations){const rows=children.get(o.parentId)??[];rows.push(o);children.set(o.parentId,rows);}
  function path(id:string){let result=paths.get(id);if(result)return result;const names:string[]=[],seen=new Set<string>();let current=byId.get(id),valid=true;
    while(current&&!seen.has(current.id)){seen.add(current.id);names.unshift(current.name);if(!current.active)valid=false;if(!current.parentId)break;current=byId.get(current.parentId);}
    if(!current||current.parentId&&seen.has(current.parentId))valid=false;result={path:names.join(' / ')||'组织已不存在',valid};paths.set(id,result);return result;
  }
  return {byId,children,path};
}
export function personSummaries(s:Pick<State,'organizations'>,members:State['members']):PersonSummary[]{
  const orgs=organizations(s);return members.map(m=>{const org=orgs.path(m.organizationId),reason=!m.active?'人员已停用':m.validUntil&&Date.parse(m.validUntil)<=Date.now()?'人员已到期':!org.valid?'所属组织已停用或无效':null;
    return {id:m.id,name:m.name,directoryId:m.directoryId,organizationId:m.organizationId,organizationPath:org.path,category:m.category,active:m.active,validUntil:m.validUntil,selectable:!reason,unavailableReason:reason};
  });
}
export function personSummary(s:Pick<State,'members'|'organizations'>,id:string):PersonSummary{
  return personSummaries(s,[pick(s.members,id,'member')])[0];
}
export function queryPeople(s:State,actorId:string,input:PersonQuery):PersonPage{
  const {members,project}=context(s,actorId,input),{page,pageSize}=paging(input),query=search(input.query);
  if(input.includeChildren!==undefined&&typeof input.includeChildren!=='boolean')throw new BadRequestException('invalid organization subtree option');
  if(input.category!==undefined&&!['employee','contractor'].includes(input.category))throw new BadRequestException('invalid person category');
  const ids=input.ids===undefined?undefined:new Set(strings(input.ids,'ids')),excluded=new Set(strings(input.excludeIds??[],'excludeIds'));
  const organizationIds=new Set<string>(),orgs=organizations(s),projectMembers=new Set(project?.memberIds??[]);
  if(input.organizationId){pick(s.organizations,input.organizationId,'organization');organizationIds.add(input.organizationId);if(input.includeChildren!==false){const pending=[input.organizationId];while(pending.length){const id=pending.pop()!;for(const o of orgs.children.get(id)??[])if(!organizationIds.has(o.id)){organizationIds.add(o.id);pending.push(o.id);}}}}
  let items=personSummaries(s,members.filter(m=>(!ids||ids.has(m.id))&&(!input.organizationId||organizationIds.has(m.organizationId))&&(!input.category||m.category===input.category))).map(person=>{
    const reason=excluded.has(person.id)?'不在本次可选范围':input.scope==='sponsor'&&person.category!=='employee'?'内部责任人必须为员工':input.scope==='project-members'&&projectMembers.has(person.id)?'已加入当前项目':person.unavailableReason;
    return {...person,selectable:!reason,unavailableReason:reason};
  }).filter(p=>(ids||!excluded.has(p.id)&&!(input.scope==='project-members'&&projectMembers.has(p.id)))&&(!query||`${p.name} ${p.directoryId} ${p.organizationPath}`.toLocaleLowerCase().includes(query)));
  items.sort((a,b)=>Number(!a.selectable)-Number(!b.selectable)||a.name.localeCompare(b.name,'zh-CN')||a.directoryId.localeCompare(b.directoryId)||a.id.localeCompare(b.id));
  return {items:ids?items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize:ids?Math.max(items.length,1):pageSize};
}
export function queryPeopleOrganizations(s:State,actorId:string,input:PersonOrganizationQuery):PersonOrganizationPage{
  const {members,all}=context(s,actorId,input),{page,pageSize}=paging(input),query=search(input.query),visible=new Set<string>(),orgs=organizations(s);
  if(all)s.organizations.forEach(o=>visible.add(o.id));else for(const m of members){let id:string|null=m.organizationId;const seen=new Set<string>();while(id&&!seen.has(id)){seen.add(id);visible.add(id);id=orgs.byId.get(id)?.parentId??null;}}
  const items=(query?s.organizations:orgs.children.get(input.parentId??null)??[]).filter(o=>visible.has(o.id)&&(!query||orgs.path(o.id).path.toLocaleLowerCase().includes(query))).map(o=>({id:o.id,name:o.name,path:orgs.path(o.id).path,parentId:o.parentId,active:o.active,hasChildren:(orgs.children.get(o.id)??[]).some(child=>visible.has(child.id))})).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN')||a.id.localeCompare(b.id));
  return {items:items.slice((page-1)*pageSize,page*pageSize),total:items.length,page,pageSize};
}
