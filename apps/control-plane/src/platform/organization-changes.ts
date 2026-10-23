import { BadRequestException,ConflictException } from '@nestjs/common';
import type { Organization,OrganizationChangeImpact,WorkspaceState } from '@ai-gateway/contracts';
import { activeMember,pick,text } from './validation';
import { futureGrantStatus,newId } from './domain';
import { automaticMatches } from './automatic-onboarding';

export function prepareOrganizationChange(s:WorkspaceState,p:Record<string,unknown>){
  const existing=p.id?pick(s.organizations,p.id,'organization'):null;
  const organization:Organization={id:existing?.id??newId('org'),name:text(p.name,'name',100),parentId:p.parentId?text(p.parentId,'parentId'):null,active:p.active!==false};
  if(organization.id===s.tenantId&&(organization.parentId||!organization.active))throw new BadRequestException('enterprise root must remain active and parentless');
  if(!organization.parentId&&organization.id!==s.tenantId)throw new BadRequestException('only enterprise root may have no parent');
  if(organization.parentId){
    let parent=pick(s.organizations,organization.parentId,'parent organization');const visited=new Set([organization.id]);
    while(parent){if(visited.has(parent.id))throw new BadRequestException('organization cycle');visited.add(parent.id);if(!parent.parentId)break;parent=pick(s.organizations,parent.parentId,'parent organization');}
  }
  const draft={...s,organizations:[...s.organizations.filter(o=>o.id!==organization.id),organization]};
  const access=(state:WorkspaceState,id:string)=>{try{activeMember(state,id);return true;}catch{return false;}};
  if(!draft.members.some(m=>m.roles.includes('operator')&&access(draft,m.id)))throw new ConflictException('organization change would disable every operator');
  const subtree=new Set([organization.id]),pending=[organization.id];
  while(pending.length){const id=pending.pop()!;for(const child of draft.organizations)if(child.parentId===id&&!subtree.has(child.id)){subtree.add(child.id);pending.push(child.id);}}
  const members=s.members.filter(m=>subtree.has(m.organizationId)),memberIds=members.map(m=>m.id),affected=new Set(memberIds);
  const rematches=!!existing&&(existing.parentId!==organization.parentId||existing.active!==organization.active);
  const parentName=(id:string|null)=>id?s.organizations.find(o=>o.id===id)?.name??id:null;
  const change:OrganizationChangeImpact={name:organization.name,beforeParent:existing?parentName(existing.parentId):null,afterParent:parentName(organization.parentId),beforeActive:existing?.active??null,afterActive:organization.active,rematches,
    organizations:draft.organizations.filter(o=>subtree.has(o.id)).map(o=>({id:o.id,name:o.name})),
    members:members.map(m=>({id:m.id,name:m.name,organizationName:draft.organizations.find(o=>o.id===m.organizationId)?.name??m.organizationId,beforeAccess:access(s,m.id),afterAccess:access(draft,m.id)})),
    personalKeyCount:s.keys.filter(k=>k.subjectType==='employee'&&affected.has(k.subjectId)&&k.status==='active').length,
    projects:s.projects.filter(v=>affected.has(v.managerId)&&v.status!=='ended').map(v=>({id:v.id,name:v.name,managerName:pick(s.members,v.managerId,'manager').name})),
    applications:s.applications.filter(v=>affected.has(v.ownerId)&&v.active).map(v=>({id:v.id,name:v.name,ownerName:pick(s.members,v.ownerId,'owner').name}))};
  const automaticGrants=rematches?members.flatMap(m=>automaticMatches(draft,m)):[];
  const monthly=s.entitlements.filter(e=>affected.has(e.memberId)&&e.planSnapshot.cadence==='monthly');
  const describe=(e:typeof monthly[number])=>({memberId:e.memberId,planName:e.planSnapshot.name});
  const stoppedFutureGrants=monthly.filter(e=>futureGrantStatus(s,e)==='scheduled'&&futureGrantStatus(draft,e)!=='scheduled').map(describe);
  const resumedFutureGrants=monthly.filter(e=>futureGrantStatus(s,e)!=='scheduled'&&futureGrantStatus(draft,e)==='scheduled').map(describe);
  return {organization,draft,memberIds,rematches,impact:{organizationChange:change,automaticGrants,totalAmount:Number(automaticGrants.reduce((n,m)=>n+m.amount,0).toFixed(6)),stoppedFutureGrants,resumedFutureGrants}};
}
