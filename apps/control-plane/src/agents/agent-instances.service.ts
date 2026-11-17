import {BadRequestException,ConflictException,Injectable,NotFoundException,ServiceUnavailableException} from '@nestjs/common';
import {createHash,randomUUID} from 'node:crypto';
import type {ManagedAgentInstance,ManagedAgentView,ManagedKey,WorkspaceState} from '@ai-gateway/contracts';
import {WorkspaceRepository,type WorkspaceTransaction} from '../platform/workspace.repository';
import {activeMember,now,text} from '../platform/validation';
import {syncResources,memberModels} from '../platform/domain';
import {workflowAction} from '../platform/workflow-actions';
import {LocalOctopRuntime} from './local-octop.runtime';

type Action='ensure'|'rotate'|'stop';
@Injectable()
export class AgentInstancesService {
  private busy=new Set<string>();
  constructor(private readonly repository:WorkspaceRepository,private readonly runtime:LocalOctopRuntime){}
  private id(state:WorkspaceState,ownerId:string){return `octop-${createHash('sha256').update(`${state.tenantId}:${ownerId}`).digest('hex').slice(0,40)}`;}
  private record(state:WorkspaceState,actorId:string,id?:string){
    const actor=activeMember(state,actorId),record=(state.agentInstances??[]).find(r=>r.id===(id??this.id(state,actor.id)));
    if(!record||record.ownerId!==actor.id&&!actor.roles.includes('operator'))throw new NotFoundException('agent instance not found');return record;
  }
  private view(state:WorkspaceState,record:ManagedAgentInstance|null):ManagedAgentView {
    if(!record)return {enabled:this.runtime.enabled,instance:null};const observed=this.runtime.observe(record.id),key=state.keys.find(k=>k.id===record.keyId);
    const unobserved=record.status==='running'&&!observed.running;
    const invalidKey=record.status==='running'&&(!key||key.status!=='active'||Date.parse(key.expiresAt)<=Date.now());
    const ready=record.status==='running'&&observed.running&&!invalidKey;
    return {enabled:this.runtime.enabled,instance:{id:record.id,ownerId:record.ownerId,status:unobserved||invalidKey?'failed':record.status,generation:record.generation,key:key?{id:key.id,masked:key.masked,status:key.status,expiresAt:key.expiresAt}:null,errorCode:unobserved?'runtime_not_observed':invalidKey?'key_unavailable':record.errorCode,updatedAt:record.updatedAt,entryUrl:ready?observed.entryUrl:null,agentId:ready?observed.agentId:null}};
  }
  async get(actorId:string,id?:string){const state=await this.repository.read();activeMember(state,actorId);if(id)return this.view(state,this.record(state,actorId,id));const record=(state.agentInstances??[]).find(r=>r.id===this.id(state,actorId))??null;return this.view(state,record);}
  /** Hold the same local lifecycle lock until a turn and any cancellation cleanup finish. */
  async beginChat(actorId:string,id:string,generation:number){
    if(this.busy.has(id))throw new ConflictException('agent operation is already in progress');this.busy.add(id);
    try{
      const state=await this.repository.read(),record=this.record(state,actorId,id),view=this.view(state,record);
      if(record.ownerId!==actorId||record.generation!==generation||record.operation||view.instance?.status!=='running')throw new ConflictException('agent instance changed before chat');
      let held=true;
      return {release:()=>{if(held){held=false;this.busy.delete(id);}},suspend:async()=>{if(held)await this.suspend(id,generation);}};
    }catch(error){this.busy.delete(id);throw error;}
  }
  private revoke(tx:WorkspaceTransaction,record:ManagedAgentInstance){const key=tx.state.keys.find(k=>k.id===record.keyId);if(key)key.status='revoked';}
  private audit(tx:WorkspaceTransaction,actorId:string,record:ManagedAgentInstance,action:string){tx.state.audit.push({id:randomUUID(),actorId,action:`agent-instance.${action}`,objectId:record.id,reason:'managed personal Octop lifecycle',createdAt:now(),detail:{ownerId:record.ownerId,generation:record.generation,keyId:record.keyId,status:record.status,errorCode:record.errorCode}});}

  async change(actorId:string,action:Action,body:Record<string,unknown>,id?:string){
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='idempotencyKey'))throw new BadRequestException('only idempotencyKey is accepted');
    const requestKey=text(body.idempotencyKey,'idempotencyKey',100);if(!/^[A-Za-z0-9_-]+$/.test(requestKey))throw new BadRequestException('invalid idempotencyKey');
    this.runtime.assertEnabled();const current=await this.repository.read(),actor=activeMember(current,actorId);
    const instanceId=id?this.record(current,actorId,id).id:this.id(current,actorId);
    if(this.busy.has(instanceId))throw new ConflictException('agent operation is already in progress');this.busy.add(instanceId);
    let token:string|undefined,operationKey='';
    try{
      const prepared=await this.repository.transact(async tx=>{
        const state=tx.state,actor=activeMember(state,actorId);state.agentInstances??=[];
        let record=state.agentInstances.find(r=>r.id===instanceId);
        if(id)this.record(state,actorId,id);
        if(!record){if(action!=='ensure'||id)throw new NotFoundException('agent instance not found');record={id:instanceId,ownerId:actor.id,status:'stopped',generation:0,keyId:null,errorCode:null,updatedAt:now()};state.agentInstances.push(record);}
        operationKey=`agent:${instanceId}:${requestKey}`;const fingerprint=`${actorId}:${action}`;
        const replay=state.operations[operationKey];if(replay){if(replay.fingerprint!==fingerprint)throw new ConflictException('idempotency key conflicts with another operation');return {replayed:true,view:this.view(state,record)};}
        if(record.operation&&Date.parse(record.operation.expiresAt)>Date.now())throw new ConflictException('agent operation is already in progress');
        if(record.operation){this.revoke(tx,record);state.operations[record.operation.key]={fingerprint:`${record.operation.actorId}:${record.operation.action}`,result:{status:'interrupted'}};record.status='failed';record.errorCode='operation_interrupted';delete record.operation;}
        if(action!=='stop')activeMember(state,record.ownerId);
        const key=state.keys.find(k=>k.id===record!.keyId);
        if(action==='ensure'&&record.status==='running'&&this.runtime.observe(record.id).running&&key?.status==='active'&&Date.parse(key.expiresAt)>Date.now()){
          state.operations[operationKey]={fingerprint,result:{instanceId,status:record.status}};return {replayed:true,view:this.view(state,record)};
        }
        if(action==='rotate'&&record.generation===0)throw new ConflictException('provision the instance before rotating its key');
        this.revoke(tx,record);record.generation++;record.errorCode=null;record.status=action==='stop'?'stopping':'provisioning';record.updatedAt=now();
        const operationToken=randomUUID();record.operation={key:operationKey,actorId,action,token:operationToken,expiresAt:new Date(Date.now()+600_000).toISOString()};
        let secret:string|undefined;let chatModelIds:string[]=[];
        if(action!=='stop'){
          const owner=activeMember(state,record.ownerId);
          chatModelIds=memberModels(state,owner.id).filter(id=>(state.definitions.find(d=>d.modelId===id)?.kind??'chat')==='chat');
          if(!chatModelIds.length)throw new ConflictException('no authorized chat models for managed instance');
          const issued=await workflowAction(tx,owner,'key.issue',{purpose:'personal',name:'Octop 专用'}) as {key:Omit<ManagedKey,'keyHash'>;secret:string};record.keyId=issued.key.id;secret=issued.secret;
        }
        await syncResources(tx);this.audit(tx,actor.id,record,`${action}.started`);
        return {replayed:false,token:operationToken,secret,ownerId:record.ownerId,chatModelIds};
      });
      if(prepared.replayed)return prepared.view;
      token=prepared.token;
      // No workspace / policy lock is held while starting Octop or delivering Key.
      if(action==='stop')await this.runtime.stop(instanceId);else await this.runtime.configure(instanceId,prepared.secret!,prepared.chatModelIds!);
      return await this.repository.transact(async tx=>{
        activeMember(tx.state,actorId);const record=this.record(tx.state,actorId,instanceId);
        if(record.operation?.token!==token)throw new ConflictException('agent operation was superseded');
        if(action!=='stop'){
          activeMember(tx.state,record.ownerId);const key=tx.state.keys.find(k=>k.id===record.keyId);
          if(key?.status!=='active'||Date.parse(key.expiresAt)<=Date.now())throw new ConflictException('managed key changed during delivery');
          const currentModels=memberModels(tx.state,record.ownerId).filter(id=>(tx.state.definitions.find(d=>d.modelId===id)?.kind??'chat')==='chat');
          if(prepared.chatModelIds!.some(id=>!currentModels.includes(id)))throw new ConflictException('managed chat models changed during delivery');
        }
        record.status=action==='stop'?'stopped':'running';record.updatedAt=now();delete record.operation;
        tx.state.operations[operationKey]={fingerprint:`${actorId}:${action}`,result:{instanceId,status:record.status,generation:record.generation}};
        this.audit(tx,actorId,record,`${action}.completed`);return this.view(tx.state,record);
      });
    }catch(error){
      if(token){
        let compensated=false;
        try{
          await this.repository.transact(async tx=>{const record=tx.state.agentInstances?.find(r=>r.id===instanceId);if(record&&record.operation?.token===token){this.revoke(tx,record);record.status='failed';record.errorCode=action==='stop'?'stop_failed':'delivery_failed';record.updatedAt=now();delete record.operation;await syncResources(tx);tx.state.operations[operationKey]={fingerprint:`${actorId}:${action}`,result:{instanceId,status:'failed'}};this.audit(tx,actorId,record,`${action}.failed`);}});
          compensated=true;
        }catch{/* The persisted operation remains available for interrupted-operation recovery. */}
        finally{try{await this.runtime.stop(instanceId);}catch{/* retry retains the instance's failure or pending operation */}}
        if(!compensated)throw new ServiceUnavailableException('agent operation failed; key revocation is pending storage recovery; runtime stop was attempted');
        throw new ConflictException('agent operation failed; its dedicated key is revoked; retry with a new idempotency key');
      }throw error;
    }finally{this.busy.delete(instanceId);}
  }
  async access(actorId:string,id?:string){
    this.runtime.assertEnabled();const state=await this.repository.read(),record=this.record(state,actorId,id);
    if(record.ownerId!==actorId)throw new NotFoundException('agent instance not found');
    if(process.env.OCTOP_LEGACY_LOGIN_ENABLED!=='true')throw new ConflictException('use the platform online Agent entry');
    if(this.busy.has(record.id)||record.operation||record.status!=='running')throw new ConflictException('instance must be running without a pending operation');
    this.busy.add(record.id);try{
      const result=await this.runtime.access(record.id);
      await this.repository.transact(async tx=>{const current=this.record(tx.state,actorId,record.id);if(current.generation!==record.generation||current.status!=='running')throw new ConflictException('instance changed during access reset');this.audit(tx,actorId,current,'access.reset');});
      return result;
    }finally{this.busy.delete(record.id);}
  }
  /** Called only by the active chat lease, while its lifecycle lock is still held. */
  private async suspend(id:string,generation:number){
    let stop=true;
    try{stop=await this.repository.transact(async tx=>{const r=tx.state.agentInstances?.find(r=>r.id===id);if(!r||r.generation!==generation)return false;this.revoke(tx,r);r.status='failed';r.errorCode='chat_cancel_failed';r.updatedAt=now();await syncResources(tx);this.audit(tx,r.ownerId,r,'chat.cancel_failed');return true;});}
    finally{if(stop)await this.runtime.stop(id);}
  }
}
