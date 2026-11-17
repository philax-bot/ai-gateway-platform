import {BadRequestException,ConflictException,GoneException,Injectable,NotFoundException,ServiceUnavailableException,UnauthorizedException,type OnModuleDestroy} from '@nestjs/common';
import {randomBytes,randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../platform/workspace.repository';
import {PlatformService} from '../platform/platform.service';
import {activeMember,hash} from '../platform/validation';

interface ImportPayload {version:1;keyId:string;providerName:string;baseUrl:string;apiKey:string;models:{id:string;name:string;enabled:true;input:['text'];api_mode:'chat_completions';api_fallback:'none';context_window:number;max_input_tokens:number}[]}
interface Handoff {id:string;ownerId:string;keyId:string;sessionHash:string;ticketHash:string;receiptHash:string|null;expiresAt:number;status:'pending'|'claimed'|'completed'|'failed';payload:ImportPayload|null;timer:NodeJS.Timeout}
@Injectable()
export class LocalOctopImportService implements OnModuleDestroy {
  private handoffs=new Map<string,Handoff>();
  constructor(private readonly repository:WorkspaceRepository,private readonly platform:PlatformService){}
  private body(body:Record<string,unknown>,fields:string[]){if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!fields.includes(k))||fields.some(k=>typeof body[k]!=='string'||!String(body[k])))throw new BadRequestException('invalid local Octop import request');}
  private async key(ownerId:string,keyId:string,sessionHash:string){
    const state=await this.repository.read();activeMember(state,ownerId);
    if(!state.sessions.some(s=>s.memberId===ownerId&&s.tokenHash===sessionHash&&Date.parse(s.expiresAt)>Date.now()))throw new UnauthorizedException('platform session expired');
    const key=state.keys.find(k=>k.id===keyId&&k.ownerId===ownerId);if(!key)throw new NotFoundException('key not found');
    if(key.status!=='active'||Date.parse(key.expiresAt)<=Date.now())throw new ConflictException('key unavailable');return key;
  }
  async create(ownerId:string,session:string,body:Record<string,unknown>){
    this.body(body,['keyId','apiKey']);if(String(body.apiKey).length>512)throw new BadRequestException('invalid API key');
    const key=await this.key(ownerId,String(body.keyId),hash(session));if(hash(String(body.apiKey))!==key.keyHash)throw new UnauthorizedException('API key does not match');
    const detail=await this.platform.keyDetail(ownerId,key.id);if(!detail.sourceActive||!detail.models.length)throw new ConflictException('key has no available models');
    const definitions=(await this.repository.read()).definitions;
    const models:ImportPayload['models']=detail.models.filter(m=>(definitions.find(d=>d.modelId===m.modelId)?.kind??'chat')==='chat').map(m=>{const definition=definitions.find(d=>d.modelId===m.modelId);if(!definition)throw new ConflictException('model access changed');return {id:m.modelId,name:m.name,enabled:true,input:['text'],api_mode:'chat_completions',api_fallback:'none',context_window:definition.contextTokens,max_input_tokens:definition.contextTokens};});
    if(!models.length)throw new ConflictException('key has no available chat models');
    const configured=process.env.PUBLIC_GATEWAY_URL;if(!configured&&process.env.PLATFORM_MODE==='production')throw new ServiceUnavailableException('PUBLIC_GATEWAY_URL is required');
    let endpoint:URL;try{endpoint=new URL(configured??'http://127.0.0.1:4000');}catch{throw new ServiceUnavailableException('invalid PUBLIC_GATEWAY_URL');}
    if(endpoint.username||endpoint.password||endpoint.search||endpoint.hash||!(endpoint.protocol==='https:'||endpoint.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)))throw new ServiceUnavailableException('PUBLIC_GATEWAY_URL must use HTTPS or loopback HTTP');
    const path=endpoint.pathname.replace(/\/+$/,'');endpoint.pathname=path.endsWith('/v1')?path:path+'/v1';
    for(const [id,r] of this.handoffs){if(r.ownerId===ownerId&&r.keyId===key.id){clearTimeout(r.timer);this.handoffs.delete(id);}}
    if(this.handoffs.size>=1000||[...this.handoffs.values()].filter(r=>r.ownerId===ownerId).length>=5)throw new ConflictException('too many pending imports');
    const id=randomUUID(),ticket=randomBytes(32).toString('base64url'),expiresAt=Date.now()+300000;
    const timer=setTimeout(()=>this.handoffs.delete(id),300000);timer.unref();
    this.handoffs.set(id,{id,ownerId,keyId:key.id,sessionHash:hash(session),ticketHash:hash(ticket),receiptHash:null,expiresAt,status:'pending',timer,payload:{version:1,keyId:key.id,providerName:`Signal Atlas ${key.id}`,baseUrl:endpoint.toString().replace(/\/$/,''),apiKey:String(body.apiKey),models}});
    return {id,expiresAt:new Date(expiresAt).toISOString(),url:`signal-octop://import?v=1&ticket=${ticket}`};
  }
  async claim(body:Record<string,unknown>){
    this.body(body,['ticket']);if(!/^[A-Za-z0-9_-]{43}$/.test(String(body.ticket)))throw new GoneException('import expired or already used');
    const record=[...this.handoffs.values()].find(r=>r.ticketHash===hash(String(body.ticket)));
    if(!record||record.status!=='pending'||record.expiresAt<=Date.now())throw new GoneException('import expired or already used');
    record.status='claimed';record.ticketHash='';const payload=record.payload;record.payload=null;
    try{await this.key(record.ownerId,record.keyId,record.sessionHash);const current=await this.platform.keyDetail(record.ownerId,record.keyId),definitions=(await this.repository.read()).definitions;if(!current.sourceActive||payload!.models.some(m=>!current.models.some(c=>c.modelId===m.id)||((definitions.find(d=>d.modelId===m.id)?.kind??'chat')!=='chat')))throw new ConflictException('model access changed');}
    catch{record.status='failed';throw new GoneException('platform login or key access changed; create a new import');}
    const receipt=randomBytes(32).toString('base64url');record.receiptHash=hash(receipt);return {id:record.id,receipt,expiresAt:new Date(record.expiresAt).toISOString(),config:payload};
  }
  complete(body:Record<string,unknown>){
    this.body(body,['id','receipt','status']);if(!['completed','failed'].includes(String(body.status)))throw new BadRequestException('invalid import result');
    const record=this.handoffs.get(String(body.id));if(!record||record.expiresAt<=Date.now()||record.status!=='claimed'||record.receiptHash!==hash(String(body.receipt)))throw new GoneException('import receipt expired or used');
    record.receiptHash=null;record.status=body.status as 'completed'|'failed';return {recorded:true};
  }
  status(ownerId:string,id:string){const r=this.handoffs.get(id);if(!r||r.ownerId!==ownerId)throw new NotFoundException('import not found or expired');return {id:r.id,status:r.status,expiresAt:new Date(r.expiresAt).toISOString()};}
  onModuleDestroy(){for(const r of this.handoffs.values())clearTimeout(r.timer);this.handoffs.clear();}
}
