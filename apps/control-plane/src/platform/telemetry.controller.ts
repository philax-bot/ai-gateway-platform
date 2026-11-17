import {Body,Controller,Get,Header,HttpCode,Post,Req,UseGuards} from '@nestjs/common';
import type {GatewayRequestTrace,GatewayTraceQuery} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {ServiceTokenGuard} from '../security/service-token.guard';
import {SessionGuard,type UserRequest} from './session.guard';
import {WorkspaceRepository} from './workspace.repository';
import {activeMember,operator} from './validation';
import {capacityResources,capacityRows} from './capacity';
import {capacityPrometheus} from './capacity-prometheus';
@Controller('/internal/v1/telemetry')
@UseGuards(ServiceTokenGuard)
export class TelemetryIngestController {
  constructor(private readonly store:DemoStore,private readonly repository:WorkspaceRepository){}
  @Post('/requests') @HttpCode(200)
  async ingest(@Body() body:GatewayRequestTrace){await this.store.recordGatewayTrace(body);return {recorded:true};}
  @Get('/metrics') @Header('content-type','text/plain; version=0.0.4; charset=utf-8')
  async metrics(){
    const resources=capacityResources(await this.repository.readCapacity());
    const counters=await this.store.capacityCounters(resources.map(r=>r.scopeId));
    return capacityPrometheus({...counters,quality:'collected',rows:capacityRows(resources,counters)});
  }
}
@Controller('/api/v1/platform/traces')
@UseGuards(SessionGuard)
export class TelemetryController {
  constructor(private readonly repository:WorkspaceRepository,private readonly store:DemoStore){}
  @Post('/query') @HttpCode(200)
  async query(@Req() request:UserRequest,@Body() body:GatewayTraceQuery){const s=await this.repository.readMaintenance();operator(activeMember(s,request.actor.id),'monitoring.read');return this.store.queryGatewayTraces(body);}
}
