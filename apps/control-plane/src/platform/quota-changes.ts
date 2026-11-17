import {ConflictException} from '@nestjs/common';
import type {BusinessQuotaBatch,Member,ProjectBudgetBatch,WorkspaceState} from '@ai-gateway/contracts';
import type {WorkspaceTransaction} from './workspace.repository';
import {manager,owner} from './domain';
import {amount,operator,pick,quotaExpiry,text} from './validation';

export function prepareQuotaChange(s:WorkspaceState,actor:Member,type:string,p:Record<string,unknown>,batches:BusinessQuotaBatch[],budgets:ProjectBudgetBatch[]){
  const project=type.startsWith('project.'),extend=type.endsWith('.extend'),returning=type==='project.return';
  if(!returning)operator(actor,'finance.write');
  const object=returning?(project?manager(s,actor,p.projectId):owner(s,actor,p.applicationId)):(project?pick(s.projects,p.projectId,'project'):pick(s.applications,p.applicationId,'application'));
  if(project&&'status'in object&&object.status==='ended'&&!returning)throw new ConflictException('项目已结束，不能调整额度');
  if(!project&&'billingMode'in object&&object.billingMode==='accounting')throw new ConflictException('记账应用不能调整额度');
  const batch=project&&!returning?pick(budgets,p.batchId,'来源预算'):pick(batches,p.batchId,'额度批次');
  if(project?batch.projectId!==object.id:!('sourceId'in batch)||batch.sourceId!==object.id||!('purpose'in batch)||batch.purpose!=='application')throw new ConflictException('额度批次不属于当前对象');
  if('accounting'in batch&&batch.accounting)throw new ConflictException('记账账户不能调整额度');
  if(returning&&(!('sourceBatchId'in batch)||!batch.sourceBatchId))throw new ConflictException('成员额度没有可退回的来源预算');
  const reason=text(p.reason,'变更原因',2000),expiresAt=extend?quotaExpiry(p):batch.expiresAt;
  const available=returning&&batch.closedAt?batch.closedAmount??0:batch.availableAmount;
  const value=extend?0:amount(p.amount);
  if(extend&&(batch.closedAt||Date.parse(batch.expiresAt)<=Date.now()||Date.parse(expiresAt)<=Date.parse(batch.expiresAt)))throw new ConflictException('仅可延长未关闭且未过期的额度');
  if(!extend&&(value>available||!returning&&(batch.closedAt||Date.parse(batch.expiresAt)<=Date.now())))throw new ConflictException('当前可调整余额不足或批次已失效，请刷新');
  const source=returning?pick(budgets,(batch as BusinessQuotaBatch).sourceBatchId,'来源预算'):null;
  return {objectId:object.id,objectName:object.name,batchId:batch.id,reason,amount:value,availableAmount:available,remainingAmount:Number((available-value).toFixed(6)),beforeExpiresAt:batch.expiresAt,expiresAt,
    title:extend?'延长额度有效期':returning?'退回成员额度至原项目预算':'回收未使用额度',
    destination:source?(source.closedAt||Date.parse(source.expiresAt)<=Date.now()?'原预算已关闭或过期，退回进入回收记录':'原项目预算，可重新分配'):extend?'仅调整期限，不增加额度':'回收记录，不计入消费',
    affectedMembers:extend&&project?batches.filter(b=>b.sourceBatchId===batch.id&&!b.closedAt).length:0};
}
export async function changeQuota(tx:WorkspaceTransaction,actor:Member,type:string,p:Record<string,unknown>){
  const prepared=prepareQuotaChange(tx.state,actor,type,p,await tx.batches(),await tx.budgetBatches());
  if(type.endsWith('.extend'))await tx.extendQuota(prepared.batchId,prepared.expiresAt,type.startsWith('project.'));
  else if(type==='project.reclaim')await tx.reclaimBudget(prepared.batchId,prepared.amount);
  else await tx.changeQuota(prepared.batchId,prepared.amount,type==='project.return'?'return':'reclaim');
  return prepared;
}
