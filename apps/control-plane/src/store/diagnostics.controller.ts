import { Controller, Get, UseGuards } from '@nestjs/common';
import { ServiceTokenGuard } from '../security/service-token.guard';
import { hotPathDiagnostics } from './hot-path-diagnostics';

@Controller('/internal/v1/diagnostics')
@UseGuards(ServiceTokenGuard)
export class DiagnosticsController {
  @Get('/hot-path')
  hotPath(){return hotPathDiagnostics.snapshot();}
}
