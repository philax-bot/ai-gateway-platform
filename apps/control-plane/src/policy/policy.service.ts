import { Injectable, Optional } from '@nestjs/common';
import type { AuthorizeRequest, AuthorizeResponse } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { PlatformService } from '../platform/platform.service';
import { authorizationFingerprint } from '../store/accounting';
import {HigressProvider} from '../gateway/higress.provider';

@Injectable()
export class PolicyService {
  constructor(private readonly store: DemoStore, @Optional() private readonly platform?: PlatformService, @Optional() private readonly higress?:HigressProvider) {}

  async authorize(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    authorizationFingerprint(input);
    const response=await this.store.authorize(input);
    const route=response.admission?.route;
    if(response.decision==='allow'&&route&&(route.kind??'chat')==='chat'&&this.higress?.enabled)route.transport=await this.higress.transport(route);
    return response;
  }

  async getDemoCredential(apiKey: string) {
    const value=await this.store.getDemoCredential(apiKey);
    return value?{...value,guardrailPolicy:await this.store.readGuardrailPolicy()}:null;
  }
}
