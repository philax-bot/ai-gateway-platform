import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import type { AuthorizeRequest } from '@ai-gateway/contracts';
import { PolicyService } from './policy.service';
import { ServiceTokenGuard } from '../security/service-token.guard';

@Controller('/internal/v1/policy')
@UseGuards(ServiceTokenGuard)
export class PolicyController {
  constructor(private readonly policyService: PolicyService) {}

  @Post('/authorize')
  @HttpCode(HttpStatus.OK)
  authorize(@Body() body: AuthorizeRequest) {
    return this.policyService.authorize(body);
  }

  @Post('/credentials/resolve')
  @HttpCode(HttpStatus.OK)
  resolveCredential(@Body() body: { apiKey: string }) {
    return this.policyService.getDemoCredential(body?.apiKey ?? '');
  }
}
