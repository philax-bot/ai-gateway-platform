import type {ApplicationActivity, ApplicationCall} from '@ai-gateway/contracts';

export function emptyActivity():ApplicationActivity {
  return {firstSuccess:null,lastSuccess:null,lastFailure:null,lastCall:null};
}

export function applicationActivity(rows:Iterable<ApplicationCall & {subjectId:string}>):Record<string,ApplicationActivity> {
  const byApp=new Map<string,ApplicationActivity>();
  for(const {subjectId,requestId,modelId,completedAt,outcome,errorCode} of rows){
    const call={requestId,modelId,completedAt,outcome,errorCode};
    const activity=byApp.get(subjectId)??emptyActivity();
    const order=(other:ApplicationCall)=>Date.parse(completedAt)-Date.parse(other.completedAt)||(requestId<other.requestId?-1:Number(requestId!==other.requestId));
    if(!activity.lastCall||order(activity.lastCall)>0)activity.lastCall=call;
    if(outcome==='completed'){
      if(!activity.firstSuccess||order(activity.firstSuccess)<0)activity.firstSuccess=call;
      if(!activity.lastSuccess||order(activity.lastSuccess)>0)activity.lastSuccess=call;
    }else if(outcome!=='client_cancelled'&&(!activity.lastFailure||order(activity.lastFailure)>0)){
      activity.lastFailure=call;
    }
    byApp.set(subjectId,activity);
  }
  return Object.fromEntries(byApp);
}
