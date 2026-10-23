import {BadRequestException,ConflictException,ForbiddenException} from '@nestjs/common';
import type {Member,WorkspaceState} from '@ai-gateway/contracts';
import {pick,strings,text} from './validation';

export function statusKeys(state:WorkspaceState,actor:Member,payload:Record<string,unknown>,bulk:boolean){
  const ids=bulk?strings(payload.ids,'ids'):[text(payload.id,'id',160)];
  if(!ids.length||ids.length>200)throw new BadRequestException('select between 1 and 200 keys');
  return ids.map(id=>{
    const key=pick(state.keys,id,'key');
    if(key.internal||!actor.roles.includes('operator')&&key.ownerId!==actor.id)throw new ForbiddenException('key is outside actor scope');
    return key;
  });
}

/** Pure preparation: validate every target before changing any key or credential. */
export function prepareKeyStatus(state:WorkspaceState,actor:Member,payload:Record<string,unknown>,bulk:boolean){
  const keys=statusKeys(state,actor,payload,bulk),status=String(payload.status);
  if(!(bulk?['disabled','revoked']:['active','disabled','revoked']).includes(status))throw new BadRequestException('invalid key status');
  const reason=text(payload.reason,'reason',2000);
  const rows=keys.map(key=>{
    if(!bulk&&key.status==='revoked')throw new ConflictException('revoked key cannot be reactivated');
    if(status==='active'&&key.projectId&&state.projects.find(project=>project.id===key.projectId)?.status==='ended')throw new ConflictException('ended project key cannot be reactivated');
    const application=key.purpose==='application'?state.applications.find(a=>a.id===key.subjectId):null;
    const member=state.members.find(m=>m.id===key.ownerId),organizationId=application?.organizationId??member?.organizationId;
    const changed=key.status!=='revoked'&&key.status!==status;
    return {id:key.id,name:key.name,masked:key.masked,ownerName:member?.name??key.ownerId,organizationName:state.organizations.find(o=>o.id===organizationId)?.name??'未归属组织',purpose:key.purpose,subjectName:application?.name??(key.projectId?state.projects.find(p=>p.id===key.projectId)?.name:'日常办公')??'—',before:key.status,after:changed?status:key.status,changed,skipReason:changed?'':key.status==='revoked'?'已吊销，不能恢复':'已是目标状态'};
  });
  return {keys,status:status as 'active'|'disabled'|'revoked',reason,rows,changedCount:rows.filter(row=>row.changed).length,skippedCount:rows.filter(row=>!row.changed).length};
}
