import { Injectable, Optional } from '@nestjs/common';
import type { AuthorizeRequest, AuthorizeResponse } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';
import { PlatformService } from '../platform/platform.service';
import { authorizationFingerprint } from '../store/accounting';

@Injectable()
export class PolicyService {
  constructor(private readonly store: DemoStore, @Optional() private readonly platform?: PlatformService) {}

  async authorize(input: AuthorizeRequest): Promise<AuthorizeResponse> {
    authorizationFingerprint(input);
    return this.store.authorize(input);
  }

  getDemoCredential(apiKey: string) {
    return this.store.getDemoCredential(apiKey);
  }
}
