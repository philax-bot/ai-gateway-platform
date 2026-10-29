import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import type { GatewaySyncRequest } from '@ai-gateway/contracts';
import { ServiceTokenGuard } from '../security/service-token.guard';
import { GatewayService } from './gateway.service';

@Controller('/internal/v1/gateway-sync')
@UseGuards(ServiceTokenGuard)
export class GatewaySyncController {
  constructor(private readonly gatewayService: GatewayService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  publish(@Body() body: GatewaySyncRequest) {
    return this.gatewayService.publish(body);
  }

  @Post('reconcile')
  reconcile(){return this.gatewayService.reconcile();}

  @Get(':resourceId')
  status(@Param('resourceId') resourceId: string) {
    return this.gatewayService.status(resourceId);
  }
}
