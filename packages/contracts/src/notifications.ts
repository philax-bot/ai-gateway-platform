export interface WebhookChannel {
  id:string;name:string;url:string;signingKeyRef:string;active:boolean;version:number;
}
export interface WebhookDelivery {
  id:string;eventId:string;eventType:string;ruleId:string|null;
  channel:WebhookChannel;
  payload:Record<string,unknown>;
  status:'pending'|'sending'|'succeeded'|'failed'|'suppressed';
  attempts:number;createdAt:string;lastAttemptAt:string|null;completedAt:string|null;
  nextAttemptAt:string|null;lastError:string|null;httpStatus:number|null;
  leaseOwner:string|null;leaseUntil:string|null;
}
