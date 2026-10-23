import { BadRequestException, Injectable } from '@nestjs/common';
import type { SettlementRequest, SettlementResponse } from '@ai-gateway/contracts';
import { DemoStore } from '../store/demo.store';

@Injectable()
export class UsageService {
  constructor(private readonly store: DemoStore) {}

  settle(input: SettlementRequest): Promise<SettlementResponse> {
    return this.store.settle(input);
  }
  renew(body:{requestId:string;reservationId:string}){
    if(!body||typeof body.requestId!=='string'||typeof body.reservationId!=='string')throw new BadRequestException('request and reservation IDs are required');
    return this.store.renewReservation(body.requestId,body.reservationId);
  }
}
