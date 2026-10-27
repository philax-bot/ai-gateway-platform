import { Injectable } from '@nestjs/common';
import type { AlertRule,CollectionStage,MonitorReading,MonitorSnapshot,WorkspaceState } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { activeMember,operator } from './validation';
import { applyAlertReading,applyCollectionReading,metricReading,monitoringState } from './monitoring.domain';

@Injectable()
export class MonitoringService {
  constructor(private readonly repository:WorkspaceRepository,private readonly store:DemoStore){}
  private async collectRows(s:WorkspaceState,from:string,to:string,reader:Pick<DemoStore,'inFlightCounts'|'queryCalls'>=this.store){
    const rows:MonitorSnapshot['rows']=[];let stage:CollectionStage='in_flight';
    try{
      const active=await reader.inFlightCounts(),objects=s.services.flatMap(service=>service.mappings.map(mapping=>({serviceId:service.id,modelId:s.definitions.find(d=>d.id===mapping.definitionId)?.modelId}))).filter((v):v is {serviceId:string;modelId:string}=>!!v.modelId);
      stage='call_totals';const total=await reader.queryCalls({from,to,limit:1});
      stage='service_models';for(const item of objects){const page=await reader.queryCalls({...item,from,to,limit:1});rows.push({...item,summary:page.summary,activeReservations:active.filter(a=>a.serviceId===item.serviceId&&a.modelId===item.modelId).reduce((n,a)=>n+a.count,0)});}
      rows.unshift({serviceId:null,modelId:'*',summary:total.summary,activeReservations:active.reduce((n,a)=>n+a.count,0)});return {rows,failedStage:null};
    }catch{return {rows:[],failedStage:stage};}
  }
  async snapshot(actorId:string):Promise<MonitorSnapshot>{
    const s=await this.repository.read();operator(activeMember(s,actorId));
    const to=new Date().toISOString(),from=new Date(Date.now()-5*60000).toISOString(),m=monitoringState(s),sample=await this.collectRows(s,from,to);
    return {from,to,collectedAt:new Date().toISOString(),quality:sample.failedStage?'collection_failed':'collected',rows:sample.rows,...m,failedStages:sample.failedStage?[sample.failedStage]:[]};
  }
  async evaluate(forceCollection=false){
    // A minute is evaluated at most once, including manual maintenance runs and process restarts.
    const bucket=Math.floor(Date.now()/60000),to=new Date(bucket*60000).toISOString();
    // Statistics may be slow or unavailable. Never hold the workspace write lock
    // while collecting them: every request admission shares that workspace row.
    const captured=await this.repository.read(),snapshot=monitoringState(captured);
    const collect=forceCollection||snapshot.collection.bucket!==bucket,failedStages:CollectionStage[]=[];
    const readings:{rule:AlertRule;reading:MonitorReading}[]=[];
    if(collect){const probe=await this.collectRows(captured,new Date((bucket-5)*60000).toISOString(),to);if(probe.failedStage)failedStages.push(probe.failedStage);}
    for(const configured of snapshot.rules){
      const active=snapshot.events.find(e=>e.ruleId===configured.id&&e.status==='active'),rule=active?.ruleSnapshot??configured;
      if(!configured.active&&!active)continue;
      const previous=snapshot.evaluations[rule.id],due=previous?.bucket!==bucket||previous.ruleVersion!==rule.version;if(!due&&!collect)continue;
      const from=new Date((bucket-rule.windowMinutes)*60000).toISOString();let summary=null;
      try{summary=(await this.store.queryCalls({from,to,serviceId:rule.serviceId??undefined,modelId:rule.modelId??undefined,limit:1})).summary;}catch{failedStages.push('rule_windows');}
      if(due)readings.push({rule,reading:metricReading(rule,summary,from,to,new Date().toISOString())});
    }
    return this.repository.transact(async tx=>{
      const m=monitoringState(tx.state);let evaluated=0;
      for(const prepared of readings){
        const configured=m.rules.find(rule=>rule.id===prepared.rule.id);if(!configured)continue;
        const active=m.events.find(e=>e.ruleId===configured.id&&e.status==='active'),rule=active?.ruleSnapshot??configured;
        if(!configured.active&&!active)continue;
        // Recheck versions and the minute under the lock: another instance or
        // operator may have updated the rule while its sample was collected.
        if(rule.version!==prepared.rule.version)continue;
        const previous=m.evaluations[rule.id];
        if(previous&&(previous.bucket>bucket||previous.bucket===bucket&&previous.ruleVersion===rule.version))continue;
        applyAlertReading(tx.state,rule,prepared.reading,bucket);evaluated++;
      }
      if(collect||failedStages.length)applyCollectionReading(tx.state,failedStages,bucket,new Date().toISOString());
      return {evaluated,collectionQuality:m.collection.quality};
    },{incrementRevision:false});
  }
}
