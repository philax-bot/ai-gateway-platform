import { BadRequestException, ForbiddenException, Injectable, OnModuleDestroy, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import type { Member } from '@ai-gateway/contracts';
import { WorkspaceRepository } from './workspace.repository';
import { activeMember, hash, now, passwordHash, text, verifyPassword } from './validation';
import { syncResources } from './domain';

interface AttemptBucket {
  failed: number[];
  pending: number;
  until: number;
}

@Injectable()
export class AuthService implements OnModuleDestroy {
  private readonly attempts = new Map<string, AttemptBucket>();
  private attemptSequence = 0;
  private static readonly ATTEMPT_WINDOW_MS = 15 * 60_000;
  private static readonly ACCOUNT_LIMIT = 10;
  private static readonly SOURCE_LIMIT = 60;
  private readonly attemptCleanup = setInterval(() => {
    const at = Date.now();
    for (const [key, bucket] of this.attempts) {
      if (bucket.until <= at && bucket.pending === 0) this.attempts.delete(key);
    }
  }, 60_000).unref();
  private logoutListeners = new Map<string,Set<()=>void>>();
  onLogout(token:string,listener:()=>void){const key=hash(token),listeners=this.logoutListeners.get(key)??new Set<()=>void>();listeners.add(listener);this.logoutListeners.set(key,listeners);return()=>{listeners.delete(listener);if(!listeners.size)this.logoutListeners.delete(key);};}
  constructor(private readonly repository: WorkspaceRepository) {}

  async bootstrapStatus() {
    const state=await this.repository.read();
    return { required: !state.members.some(m=>m.roles.includes('operator')&&m.passwordHash), devLogin: process.env.DEV_LOGIN==='true',tokenRequired:!!process.env.BOOTSTRAP_TOKEN };
  }

  async setup(body:Record<string,unknown>,ip:string) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('invalid setup request');
    const local=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(ip);
    if(process.env.BOOTSTRAP_TOKEN ? hash(String(body.bootstrapToken??''))!==hash(process.env.BOOTSTRAP_TOKEN) : !local)throw new ForbiddenException('bootstrap token required for remote setup');
    const directoryId=text(body.directoryId,'directoryId',100),name=text(body.name,'name',100),password=text(body.password,'password',256);
    return this.repository.transact(async tx=>{
      if(tx.state.members.some(m=>m.roles.includes('operator')&&m.passwordHash))throw new BadRequestException('workspace already initialized');
      let member=tx.state.members.find(m=>m.roles.includes('operator'));
      if(tx.state.members.some(m=>m.id!==member?.id&&m.directoryId===directoryId))throw new BadRequestException('directory ID already exists');
      if(!member){member={id:`member-${randomBytes(16).toString('hex')}`,name,directoryId,organizationId:tx.state.tenantId,category:'employee',tags:[],roles:['operator','employee'],active:true,validUntil:null,sponsorId:null};tx.state.members.push(member);}
      member.directoryId=directoryId;member.name=name;member.passwordHash=passwordHash(password);
      tx.state.audit.push({id:randomBytes(16).toString('hex'),actorId:member.id,action:'workspace.bootstrap',objectId:member.id,reason:'initial setup',createdAt:now(),detail:{}});
      return {initialized:true};
    },{diagnosticContext:'auth_setup'});
  }

  onModuleDestroy() {
    clearInterval(this.attemptCleanup);
  }

  private rateLimited(key: string, limit: number, at: number): boolean {
    const bucket = this.attempts.get(key);
    return !!bucket && bucket.pending + (bucket.until > at ? bucket.failed.length : 0) >= limit;
  }

  private startWindow(bucket: AttemptBucket, at: number) {
    if (bucket.until > at) return;
    bucket.failed = [];
    bucket.until = at + AuthService.ATTEMPT_WINDOW_MS;
  }

  private reserveAttempt(key: string, at: number): AttemptBucket {
    const bucket = this.attempts.get(key) ?? {failed: [], pending: 0, until: 0};
    this.startWindow(bucket, at);
    bucket.pending++;
    this.attempts.set(key, bucket);
    return bucket;
  }

  async login(body:Record<string,unknown>,ip:string) {
    if(!body||typeof body!=='object'||Array.isArray(body))throw new BadRequestException('invalid login request');
    const directoryId=text(body.directoryId,'directoryId',100),password=text(body.password,'password',256);
    const at = Date.now(), sourceKey = `source:${ip}`, accountKey = `account:${directoryId}`;
    if (this.rateLimited(sourceKey, AuthService.SOURCE_LIMIT, at) || this.rateLimited(accountKey, AuthService.ACCOUNT_LIMIT, at)) {
      throw new UnauthorizedException('too many login attempts; retry later');
    }
    const attempt = ++this.attemptSequence;
    const source = this.reserveAttempt(sourceKey, at), account = this.reserveAttempt(accountKey, at);
    let invalidCredentials = false;
    try {
      const result=await this.repository.transact(async tx=>{
        const member=tx.state.members.find(m=>m.directoryId===directoryId);
        if(!member?.passwordHash||!verifyPassword(password,member.passwordHash)){
          invalidCredentials = true;
          throw new UnauthorizedException('invalid credentials');
        }
        activeMember(tx.state,member.id);
        const token=randomBytes(32).toString('base64url');
        tx.state.sessions=tx.state.sessions.filter(s=>Date.parse(s.expiresAt)>Date.now());
        tx.state.sessions.push({tokenHash:hash(token),memberId:member.id,createdAt:now(),expiresAt:new Date(Date.now()+8*60*60_000).toISOString()});
        return {token,member:this.publicMember(member)};
      },{diagnosticContext:'auth_login'});
      // A successful attempt clears earlier account failures. Other requests may finish first.
      account.failed = account.failed.filter(failedAttempt => failedAttempt > attempt);
      return result;
    } finally {
      const finishedAt = Date.now();
      for (const [key, bucket] of [[sourceKey, source], [accountKey, account]] as const) {
        bucket.pending--;
        if (invalidCredentials) {
          this.startWindow(bucket, finishedAt);
          bucket.failed.push(attempt);
        }
        if (bucket.pending === 0 && (bucket.failed.length === 0 || bucket.until <= finishedAt)) {
          this.attempts.delete(key);
        }
      }
    }
  }

  async authenticate(token:string):Promise<Member> {
    if(!token)throw new UnauthorizedException('login required');
    const state=await this.repository.readAuthentication();
    const session=state.sessions.find(s=>s.tokenHash===hash(token)&&Date.parse(s.expiresAt)>Date.now());
    if(!session)throw new UnauthorizedException('session expired');
    return activeMember(state,session.memberId);
  }

  async logout(token:string) {
    await this.repository.transact(async tx=>{
      const sessionHash=hash(token);tx.state.sessions=tx.state.sessions.filter(s=>s.tokenHash!==sessionHash);
      let changed=false;for(const key of tx.state.keys)if(key.internal&&key.onlineSessionHash===sessionHash&&key.status!=='revoked'){key.status='revoked';changed=true;}
      if(changed)await syncResources(tx);
    },{diagnosticContext:'auth_logout'});
    for(const listener of this.logoutListeners.get(hash(token))??[])listener();
    return {loggedOut:true};
  }

  publicMember(member:Member):Omit<Member,'passwordHash'> {const {passwordHash:ignored,...publicValue}=member;return publicValue;}
}
