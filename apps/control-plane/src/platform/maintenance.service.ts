import { Injectable, OnApplicationBootstrap, OnModuleDestroy,Optional } from '@nestjs/common';
import { DemoStore } from '../store/demo.store';
import { WorkspaceRepository } from './workspace.repository';
import { hasPeriodicWork, runPeriodic, syncResources } from './domain';
import { MonitoringService } from './monitoring.service';
import {retentionDue,scheduledRetention} from './retention';

@Injectable()
export class MaintenanceService implements OnApplicationBootstrap,OnModuleDestroy {
  private timer:ReturnType<typeof setInterval>|undefined;
  private active:Promise<{issued:number;expired:number}>|null=null;
  private readonly state:{lastRunAt:string|null;lastSuccessAt:string|null;error:string|null}={lastRunAt:null,lastSuccessAt:null,error:null};
  constructor(private readonly repository:WorkspaceRepository,private readonly store:DemoStore,@Optional() private readonly monitoring?:MonitoringService){}
  async onApplicationBootstrap(){
    if(process.env.MAINTENANCE_DISABLED==='true')return;
    await this.run().catch(()=>undefined);
    const configured=Number(process.env.MAINTENANCE_INTERVAL_MS??60000),interval=Number.isFinite(configured)?Math.max(1000,configured):60000;
    this.timer=setInterval(()=>{void this.run().catch(()=>undefined);},interval);this.timer.unref();
  }
  status(){return {...this.state,running:!!this.active};}
  run(){
    if(this.active)return this.active;
    this.state.lastRunAt=new Date().toISOString();
    const work=(async()=>{
      let issued=0,expired=0,failure:unknown;
      try{
        // Idle ticks must not queue exclusive workspace locks ahead of admissions.
        // Actual grant/retention work is still rechecked inside its normal transaction.
        if(hasPeriodicWork(await this.repository.read()))issued=await this.repository.transact(async tx=>{const result=await runPeriodic(tx);if(result.issuedBatchIds.length)await syncResources(tx);return result.issuedBatchIds.length;},{diagnosticContext:'periodic_grant'});
        const reservations=await this.store.listExpiredReservations();expired=reservations.length;
        for(const reservation of reservations)await this.store.settle({...reservation,idempotencyKey:`${reservation.requestId}:lease-expired`,outcome:'partial',usageFinal:false,inputTokens:0,outputTokens:0,cachedInputTokens:0,actualAmount:0,completedAt:new Date().toISOString()});
      }catch(error){failure=error;}
      try{await this.monitoring?.evaluate();}catch(error){failure??=error;}
      try{if(retentionDue(await this.repository.read()))await this.repository.transact(async tx=>scheduledRetention(tx.state),{incrementRevision:false,runtimeOnly:true,diagnosticContext:'retention'});}catch(error){failure??=error;}
      if(failure)throw failure;
      this.state.lastSuccessAt=new Date().toISOString();this.state.error=null;
      return {issued,expired};
    })();
    const tracked=work.then(result=>{this.active=null;return result;},error=>{this.state.error='maintenance_unavailable';this.active=null;throw error;});
    this.active=tracked;
    return tracked;
  }
  async onModuleDestroy(){if(this.timer)clearInterval(this.timer);await this.active?.catch(()=>undefined);}
}
