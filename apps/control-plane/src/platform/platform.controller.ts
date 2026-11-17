import { Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards, UseInterceptors } from '@nestjs/common';
import { BillingVisibilityInterceptor } from './billing-visibility';
import type { CallQuery, PlatformCommand } from '@ai-gateway/contracts';
import { PlatformService } from './platform.service';
import { SessionGuard, sessionToken, type UserRequest } from './session.guard';
import { MaintenanceService } from './maintenance.service';
import { operator } from './validation';
import { MonitoringService } from './monitoring.service';

@Controller('/api/v1/platform')
@UseGuards(SessionGuard)
@UseInterceptors(BillingVisibilityInterceptor)
export class PlatformController {
  constructor(private readonly platform:PlatformService,private readonly maintenance:MaintenanceService,private readonly monitoring:MonitoringService){}
  @Post('/safety/query') @HttpCode(200)
  safety(@Req() request:UserRequest,@Body() body:import('@ai-gateway/contracts').SafetyQuery){return this.platform.safetyReport(request.actor.id,body);}
  @Post('/safety/trial') @HttpCode(200)
  safetyTrial(@Req() request:UserRequest,@Body() body:Record<string,unknown>){return this.platform.safetyTrial(request.actor.id,body);}
  @Get('/state') state(@Req() request:UserRequest){return this.platform.snapshot(request.actor.id);}
  @Post('/people/query') @HttpCode(200)
  people(@Req() request:UserRequest,@Body() body:import('@ai-gateway/contracts').PersonQuery){return this.platform.people(request.actor.id,body);}
  @Post('/people/organizations') @HttpCode(200)
  peopleOrganizations(@Req() request:UserRequest,@Body() body:import('@ai-gateway/contracts').PersonOrganizationQuery){return this.platform.peopleOrganizations(request.actor.id,body);}
  @Get('/retention') retention(@Req() request:UserRequest){return this.platform.retentionReport(request.actor.id);}
  @Get('/approvals/:id') approval(@Req() request:UserRequest,@Param('id') id:string){return this.platform.approvalDetail(request.actor.id,id);}
  @Get('/keys/:id') key(@Req() request:UserRequest,@Param('id') id:string){return this.platform.keyDetail(request.actor.id,id);}
  @Get('/projects/:id') project(@Req() request:UserRequest,@Param('id') id:string){return this.platform.projectDetail(request.actor.id,id);}
  @Get('/projects/:id/member-candidates') projectCandidates(@Req() request:UserRequest,@Param('id') id:string){return this.platform.projectMemberCandidates(request.actor.id,id);}
  @Get('/applications/:id') application(@Req() request:UserRequest,@Param('id') id:string){return this.platform.applicationDetail(request.actor.id,id);}
  @Get('/calls/:requestId')
  callRelations(@Req() request:UserRequest,@Param('requestId') requestId:string){return this.platform.callRelations(request.actor.id,requestId);}
  @Post('/calls/query') @HttpCode(200)
  calls(@Req() request:UserRequest,@Body() body:CallQuery){return this.platform.queryCalls(request.actor.id,body);}
  @Post('/analytics/usage') @HttpCode(200)
  usageAnalytics(@Req() request:UserRequest,@Body() body:import('@ai-gateway/contracts').UsageAnalyticsQuery){return this.platform.usageAnalytics(request.actor.id,body);}
  @Post('/audit/query') @HttpCode(200)
  audit(@Req() request:UserRequest,@Body() body:import('@ai-gateway/contracts').AuditQuery){return this.platform.queryAudit(request.actor.id,body);}
  @Get('/upstream-credentials/:id/usage')
  credentialUsage(@Req() request:UserRequest,@Param('id') id:string){return this.platform.credentialUsage(request.actor.id,id);}
  @Get('/monitoring')
  monitoringSnapshot(@Req() request:UserRequest){return this.monitoring.snapshot(request.actor.id);}
  @Get('/monitoring/capacity')
  capacitySnapshot(@Req() request:UserRequest){return this.monitoring.capacity(request.actor.id);}
  @Post('/monitoring/check') @HttpCode(200)
  monitoringCheck(@Req() request:UserRequest){operator(request.actor,'monitoring.write');return this.monitoring.evaluate(true);}
  @Post('/pools/:id/simulate') @HttpCode(200)
  simulateRouting(@Req() request:UserRequest,@Param('id') id:string,@Body() body:import('@ai-gateway/contracts').RoutingSimulationInput){return this.platform.simulateRouting(request.actor.id,id,body);}
  @Post('/preview') @HttpCode(200)
  preview(@Req() request:UserRequest,@Body() body:PlatformCommand){return this.platform.preview(request.actor.id,body);}
  @Post('/commands') @HttpCode(200)
  execute(@Req() request:UserRequest,@Body() body:PlatformCommand){return this.platform.execute(request.actor.id,body);}
  @Post('/services/:id/acceptance') @HttpCode(200)
  acceptance(@Req() request:UserRequest,@Param('id') id:string,@Body() body:Record<string,unknown>){return this.platform.acceptService(request.actor.id,id,body);}
  @Post('/services/:id/verify') @HttpCode(200)
  verify(@Req() request:UserRequest,@Param('id') id:string,@Body() body:Record<string,unknown>={}){return this.platform.verifyService(request.actor.id,id,body);}
  @Get('/services/:id/verifications')
  verifications(@Req() request:UserRequest,@Param('id') id:string,@Query('limit') limit?:string,@Query('before') before?:string){return this.platform.verificationHistory(request.actor.id,id,{limit,before});}
  @Post('/online-credential') @HttpCode(200)
  onlineCredential(@Req() request:UserRequest,@Body() body:Record<string,unknown>){return this.platform.onlineCredential(request.actor.id,body,sessionToken(request));}
  @Post('/media/tasks/query') @HttpCode(200)
  mediaTasks(@Req() request:UserRequest,@Body() body:{cursor?:string;limit?:number}){return this.platform.mediaTasks(request.actor.id,body);}
  @Post('/quote') @HttpCode(200)
  quote(@Req() request:UserRequest,@Body() body:Record<string,unknown>){return this.platform.quote(request.actor.id,body);}
  @Post('/maintenance/run') @HttpCode(200)
  maintenanceRun(@Req() request:UserRequest){operator(request.actor);return this.maintenance.run();}
}
