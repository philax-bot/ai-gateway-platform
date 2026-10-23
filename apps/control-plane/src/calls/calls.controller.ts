import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DemoStore } from '../store/demo.store';
import { ServiceTokenGuard } from '../security/service-token.guard';

@Controller('/api/v1/calls')
@UseGuards(ServiceTokenGuard)
export class CallsController {
  constructor(private readonly store: DemoStore) {}

  @Get()
  async list() {
    return { data: await this.store.listCalls() };
  }

  @Get('/quota')
  quota(@Query('purpose') purpose = 'personal') {
    if (purpose !== 'personal' && purpose !== 'project') throw new BadRequestException('unsupported demo purpose');
    return this.store.getQuota(purpose);
  }
}
