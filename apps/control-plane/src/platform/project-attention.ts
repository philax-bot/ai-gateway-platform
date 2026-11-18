import type {BusinessQuotaBatch, Project, ProjectAttention, ProjectBudgetBatch} from '@ai-gateway/contracts';

export function projectAttention(project:Project, activeMembers:ReadonlySet<string>, budgets:ProjectBudgetBatch[], batches:BusinessQuotaBatch[], now=Date.now()):ProjectAttention {
  const funded=new Set<string>(), assigned=new Map<string,number>();
  for(const batch of batches){
    if(batch.projectId!==project.id||batch.purpose!=='project'||batch.closedAt||Date.parse(batch.expiresAt)<=now||batch.availableAmount<=0)continue;
    funded.add(batch.sourceId);
    if(batch.sourceBatchId)assigned.set(batch.sourceBatchId,(assigned.get(batch.sourceBatchId)??0)+batch.availableAmount);
  }
  const deadline=now+7*86400000;
  const expiringBudgets=budgets.filter(b=>b.projectId===project.id&&!b.closedAt&&Date.parse(b.expiresAt)>now&&Date.parse(b.expiresAt)<=deadline)
    .map(b=>({id:b.id,expiresAt:b.expiresAt,amount:Number((b.availableAmount+(assigned.get(b.id)??0)).toFixed(6))}))
    .filter(b=>b.amount>0).sort((a,b)=>Date.parse(a.expiresAt)-Date.parse(b.expiresAt));
  return {unfundedMemberIds:project.memberIds.filter(id=>activeMembers.has(id)&&!funded.has(id)),expiringBudgets};
}
