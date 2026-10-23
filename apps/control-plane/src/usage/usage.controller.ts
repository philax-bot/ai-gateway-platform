import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import type { SettlementRequest } from '@ai-gateway/contracts';
import { ServiceTokenGuard } from '../security/service-token.guard';
import { UsageService } from './usage.service';

@Controller('/internal/v1/usage')
@UseGuards(ServiceTokenGuard)
export class UsageController {
  constructor(private readonly usageService: UsageService) {}

  @Post('/settlements')
  @HttpCode(HttpStatus.OK)
  settle(@Body() body: SettlementRequest) {
    return this.usageService.settle(body);
  }
  @Post('/leases/renew') @HttpCode(HttpStatus.OK)
  renew(@Body() body:{requestId:string;reservationId:string}){return this.usageService.renew(body);}
}
