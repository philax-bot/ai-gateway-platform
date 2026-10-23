import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Member } from '@ai-gateway/contracts';
import { AuthService } from './auth.service';

export interface UserRequest { headers: Record<string,string|undefined>; ip: string; actor: Member }
export function sessionToken(request:Pick<UserRequest,'headers'>):string {
  const bearer=request.headers.authorization;
  if(bearer?.startsWith('Bearer '))return bearer.slice(7);
  const cookie=request.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('signal_session='));
  return cookie?.slice('signal_session='.length)??'';
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth:AuthService){}
  async canActivate(context:ExecutionContext) {
    const request=context.switchToHttp().getRequest<UserRequest>();request.actor=await this.auth.authenticate(sessionToken(request));return true;
  }
}
