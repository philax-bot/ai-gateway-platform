import { Controller, Get } from '@nestjs/common';
import { DemoStore } from '../store/demo.store';
import { MaintenanceService } from '../platform/maintenance.service';

@Controller('/health')
export class HealthController {
  constructor(private readonly store: DemoStore,private readonly maintenance:MaintenanceService) {}

  @Get()
  async health() {const dependencies=await this.store.health(),maintenance=this.maintenance.status();return {...dependencies,status:maintenance.error?'degraded':dependencies.status,maintenance};}
}
