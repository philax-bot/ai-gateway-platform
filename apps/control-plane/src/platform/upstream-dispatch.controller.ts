import {Body,Controller,HttpCode,Post,UseGuards,ConflictException} from '@nestjs/common';
import {isRequestReference} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {ServiceTokenGuard} from '../security/service-token.guard';
import {WorkspaceRepository} from './workspace.repository';
import {routeSecret} from './upstream-credentials';

@Controller('/internal/v1/upstream')
@UseGuards(ServiceTokenGuard)
export class UpstreamDispatchController {
  constructor(private readonly store:DemoStore,private readonly repository:WorkspaceRepository){}
  @Post('/resolve') @HttpCode(200)
  async resolve(@Body() body:{requestId:string;reservationId:string;jobId?:string}){
    if(!isRequestReference(body?.requestId)||!isRequestReference(body.reservationId))throw new ConflictException('valid reservation required');
    const route=await this.store.dispatchRoute(body.requestId,body.reservationId,body.jobId);
    if(!route)throw new ConflictException('dispatch reservation is inactive or does not match');
    return {secret:routeSecret(await this.repository.readUpstreamCredentials(),route)};
  }
}
