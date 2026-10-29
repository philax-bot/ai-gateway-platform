import {createHash} from 'node:crypto';

/** PoC-only file publisher. A successful copy is pending until a data-plane probe succeeds. */
export class IsolatedFilePublisher{
  constructor({write,probe}){this.write=write;this.probe=probe;this.appliedVersion=null;this.operations=[];this.inputs=new Map();}
  async publish(resource,{idempotencyKey,timeoutMs=12000}={}){
    if(typeof idempotencyKey!=='string'||!idempotencyKey)throw new Error('configuration idempotency key required');
    const fingerprint=createHash('sha256').update(JSON.stringify(resource)).digest('hex');
    if(this.inputs.has(idempotencyKey)){
      const previous=this.inputs.get(idempotencyKey);
      if(previous.fingerprint!==fingerprint)throw new Error('configuration idempotency conflict');
      return previous.operation;
    }
    const desiredVersion=resource.metadata.annotations['higress.io/response-header-control-update'].split(' ')[1];
    const operation={desiredVersion,appliedVersion:this.appliedVersion,status:'pending',observedVersion:null,errorCode:null};
    this.inputs.set(idempotencyKey,{fingerprint,operation});this.operations.push(operation);
    try{
      await this.write(resource);
      const deadline=Date.now()+timeoutMs;
      do{
        const result=await this.probe().catch(()=>({ok:false,version:null}));operation.observedVersion=result.version;
        if(result.ok&&result.version===desiredVersion){this.appliedVersion=desiredVersion;operation.appliedVersion=desiredVersion;operation.status='applied';return operation;}
        await new Promise(resolve=>setTimeout(resolve,150));
      }while(Date.now()<deadline);
      throw new Error('runtime configuration was not confirmed');
    }catch{
      operation.status='rejected';operation.errorCode='runtime_not_confirmed';return operation;
    }
  }
}
