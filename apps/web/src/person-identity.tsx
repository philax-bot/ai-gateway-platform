import type {Member,PersonSummary,PlatformSnapshot} from '@ai-gateway/contracts';
import {organizationPath} from './organizations';

export function personLabel(person:Partial<Pick<Member,'name'|'directoryId'>>|undefined){return person?.name?`${person.name}${person.directoryId?`（${person.directoryId}）`:''}`:'人员已不存在或不可见';}
export function memberLabel(data:Pick<PlatformSnapshot,'members'>,id:string){return personLabel(data.members.find(m=>m.id===id));}
export function memberIdentity(data:Pick<PlatformSnapshot,'members'|'organizations'>,id:string){const member=data.members.find(m=>m.id===id);return member?`${personLabel(member)} · ${organizationPath(data.organizations,member.organizationId)}`:personLabel(undefined);}
export function PersonIdentity({person}:{person:Partial<PersonSummary>|undefined}){
  return <span className="person-identity"><span className="person-identity-name"><strong>{person?.name??'人员已不存在或不可见'}</strong>{person?.directoryId&&<code>{person.directoryId}</code>}</span><small>{person?.organizationPath??'组织信息待核对'}</small>{person?.category&&<small>{person.category==='contractor'?'外部协作':'员工'}{person.validUntil?` · 有效至 ${new Date(person.validUntil).toLocaleDateString('zh-CN',{timeZone:'Asia/Shanghai'})}`:''}</small>}{person?.unavailableReason&&<small className="person-identity-warning">{person.unavailableReason}</small>}</span>;
}
