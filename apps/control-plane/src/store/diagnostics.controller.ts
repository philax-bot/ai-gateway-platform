import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../security/service-token.guard';
import { hotPathDiagnostics } from './hot-path-diagnostics';

@Controller('/internal/v1/diagnostics')
@UseGuards(ServiceTokenGuard)
export class DiagnosticsController {
  @Get('/hot-path')
  hotPath(@Query('after') after?:string){
    if(after!==undefined&&(!/^\d+$/.test(after)||!Number.isSafeInteger(Number(after))))throw new BadRequestException('invalid diagnostics checkpoint');
    return hotPathDiagnostics.snapshot(Number(after??0));
  }
}
