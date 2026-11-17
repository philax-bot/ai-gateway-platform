import {Body,Controller,HttpCode,Post,UseGuards} from '@nestjs/common';
import {isRequestReference,type MediaJobReceipt,type MediaJobUpdate} from '@ai-gateway/contracts';
import {BadRequestException} from '@nestjs/common';
import {DemoStore} from '../store/demo.store';
import {ServiceTokenGuard} from '../security/service-token.guard';
import {jobId} from '../store/media-jobs';
@Controller('/internal/v1/media/jobs')
@UseGuards(ServiceTokenGuard)
export class MediaJobsController {
  constructor(private readonly store:DemoStore){}
  @Post('/create') @HttpCode(200)
  create(@Body() body:{id:string;requestId:string;reservationId:string}){jobId(body?.id);if(!isRequestReference(body.requestId)||!isRequestReference(body.reservationId))throw new BadRequestException('invalid job reservation');return this.store.createMediaJob(body);}
  @Post('/find') @HttpCode(200)
  find(@Body() body:{requestId:string}){if(!isRequestReference(body?.requestId))throw new BadRequestException('invalid request reference');return this.store.findMediaJob(body.requestId);}
  @Post('/get') @HttpCode(200)
  get(@Body() body:{id:string}){return this.store.getMediaJob(jobId(body?.id));}
  @Post('/claim') @HttpCode(200)
  claim(@Body() body:{workerId:string}){if(!isRequestReference(body?.workerId))throw new BadRequestException('invalid worker');return this.store.claimMediaJobs(body.workerId);}
  @Post('/cancel/claim') @HttpCode(200)
  cancelClaim(@Body() body:{id:string;token:string}){return this.store.claimMediaCancellation(jobId(body?.id),jobId(body?.token));}
  @Post('/receipt') @HttpCode(200)
  receipt(@Body() body:MediaJobReceipt){return this.store.mediaJobReceipt(body);}
  @Post('/update') @HttpCode(200)
  update(@Body() body:MediaJobUpdate){return this.store.updateMediaJob(body);}
}
