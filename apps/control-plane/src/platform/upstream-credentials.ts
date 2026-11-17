import {BadRequestException,ConflictException} from '@nestjs/common';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {modelProviders,type FrozenCredential,type PublicUpstreamCredential,type RouteSnapshot,type UpstreamCredential,type WorkspaceState} from '@ai-gateway/contracts';
import {newId} from './domain';
import {pick,text} from './validation';

function masterKey():Buffer {
  const raw=process.env.PLATFORM_CREDENTIAL_ENCRYPTION_KEY;
  if(!raw||!/^[A-Za-z0-9+/]{43}=$/.test(raw))throw new ConflictException('credential encryption key must be a 32-byte base64 value');
  const key=Buffer.from(raw,'base64');
  if(key.length!==32)throw new ConflictException('credential encryption key must be a 32-byte base64 value');
  return key;
}

export function publicUpstreamCredential(credential:UpstreamCredential):PublicUpstreamCredential {
  return {...credential,versions:credential.versions.map(({version,createdAt,masked})=>({version,createdAt,masked}))};
}

export function saveUpstreamCredential(state:WorkspaceState,payload:Record<string,unknown>):PublicUpstreamCredential {
  const credentials=state.upstreamCredentials??=[];
  const existing=payload.id?pick(credentials,payload.id,'upstream credential'):null;
  const providerId=text(payload.providerId??existing?.providerId,'providerId');
  if(!modelProviders(state.providers).some(provider=>provider.id===providerId))throw new BadRequestException('provider not found');
  if(existing&&providerId!==existing.providerId)throw new BadRequestException('credential provider cannot be changed');
  const at=new Date().toISOString();
  const credential:UpstreamCredential=existing??{id:newId('upstream-credential'),name:'',providerId,active:true,currentVersion:0,createdAt:at,updatedAt:at,versions:[]};
  if(payload.secret!==undefined&&payload.secret!==''){
    const secret=text(payload.secret,'secret',8192);
    if(/[\r\n\u0000]/.test(secret))throw new BadRequestException('invalid upstream secret');
    const version=credential.currentVersion+1,iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',masterKey(),iv);
    cipher.setAAD(Buffer.from(JSON.stringify([credential.id,providerId,version])));
    const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
    credential.versions.push({version,createdAt:at,masked:secret.length>8?`••••${secret.slice(-4)}`:'••••',ciphertext:ciphertext.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64')});
    credential.currentVersion=version;
  }
  if(!credential.currentVersion)throw new BadRequestException('secret required for a new credential');
  credential.name=text(payload.name??existing?.name,'name',100);credential.active=payload.active===undefined?existing?.active??true:payload.active!==false;credential.updatedAt=at;if(!existing&&payload.serviceId)credential.serviceId=String(payload.serviceId);
  if(!existing)credentials.push(credential);
  if(existing&&payload.secret){
    for(const service of state.services.filter(service=>service.credentialId===credential.id)){
      service.configVersion++;service.verification='unverified';service.protocolCapabilities=undefined;
      service.verificationMessage='上游凭据已轮换，需要重新验证';service.verifiedAt=null;
    }
  }
  return publicUpstreamCredential(credential);
}

/** Only internal dispatch paths call this function. Disabled credentials remain usable by frozen work. */
export function resolveUpstreamCredential(state:Pick<WorkspaceState,'upstreamCredentials'>,frozen:FrozenCredential):string {
  const credential=pick(state.upstreamCredentials??[],frozen.id,'upstream credential');
  const version=credential.versions.find(item=>item.version===frozen.version);
  if(!version?.ciphertext||!version.iv||!version.tag)throw new ConflictException('credential version unavailable');
  try{
    const decipher=createDecipheriv('aes-256-gcm',masterKey(),Buffer.from(version.iv,'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify([credential.id,credential.providerId,version.version])));
    decipher.setAuthTag(Buffer.from(version.tag,'base64'));
    return Buffer.concat([decipher.update(Buffer.from(version.ciphertext,'base64')),decipher.final()]).toString('utf8');
  }catch{throw new ConflictException('credential decryption failed');}
}

export function frozenServiceCredential(state:Pick<WorkspaceState,'upstreamCredentials'>,id:string|undefined|null):FrozenCredential|undefined {
  if(!id)return undefined;
  const credential=pick(state.upstreamCredentials??[],id,'upstream credential');
  if(!credential.active)throw new ConflictException('upstream credential is disabled');
  return {id:credential.id,version:credential.currentVersion};
}

export function routeSecret(state:Pick<WorkspaceState,'upstreamCredentials'>,route:Pick<RouteSnapshot,'credential'|'credentialRef'>):string {
  if(route.credential)return resolveUpstreamCredential(state,route.credential);
  if(!route.credentialRef)return '';
  const secret=process.env[route.credentialRef];
  if(!/^UPSTREAM_[A-Z0-9_]+$/.test(route.credentialRef)||!secret)throw new ConflictException('controlled credential reference is not configured');
  return secret;
}
