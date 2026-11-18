import {BadRequestException,ForbiddenException} from '@nestjs/common';
import type {Member,PlatformCommand,WorkspaceState} from '@ai-gateway/contracts';
import {canApprove,manager,owner} from './domain';
import {operator,pick} from './validation';
import {statusKeys} from './key-status';
import {hasPermission,type Permission} from '@ai-gateway/contracts';
import {isDeepStrictEqual} from 'node:util';
import {serviceBaseUrl} from './model-configuration';

const commandPermissions:Record<string,Permission> = {
  'save.provider':'models.write',
  'delete.provider':'models.write',
  'save.definition':'models.write',
  'save.service':'models.write',
  'save.pool':'models.write',
  'pricing.update':'pricing.write',
  'credential.save':'credentials.write',
  'save.alert-rule':'monitoring.write',
  'alert.ack':'monitoring.write',
  'alert.silence':'monitoring.write',
  'notification.channel.save':'monitoring.write',
  'notification.delivery.retry':'monitoring.write',
  'usage.reconcile':'finance.write',
  'project.fund':'finance.write',
  'application.fund':'finance.write',
  'project.reclaim':'finance.write',
  'project.extend':'finance.write',
  'application.reclaim':'finance.write',
  'application.extend':'finance.write',
};

function authorizePricing(state:WorkspaceState,actor:Member,command:PlatformCommand):void {
  if (hasPermission(actor,'pricing.write')) return;
  const payload=command.payload;
  if (command.type==='save.definition' && payload.billingMultiplier!==undefined) {
    const current=state.definitions.find(model=>model.id===payload.id)?.billingMultiplier??1;
    if (payload.billingMultiplier!==current) operator(actor,'pricing.write');
  }
  if (command.type!=='save.service' || !Array.isArray(payload.mappings)) return;
  const service=state.services.find(item=>item.id===payload.id);
  for (const mapping of payload.mappings as Record<string,unknown>[]) {
    const current=service?.mappings.find(item=>item.definitionId===mapping.definitionId);
    for (const field of ['inputPrice','outputPrice','cachedInputPrice','costPrice','meter'] as const) {
      if (mapping[field]!==undefined && !isDeepStrictEqual(mapping[field]??null,current?.[field]??null)) {
        operator(actor,'pricing.write');
      }
    }
  }
}

/** Moving a model service moves its upstream credential to a new destination, so an
 * endpoint change is a credential operation rather than only a model one. */
function authorizeServiceEndpoint(state:WorkspaceState,actor:Member,command:PlatformCommand):void{
  const existing=state.services.find(service=>service.id===command.payload.id);
  if(existing && serviceBaseUrl(command.payload.baseUrl)!==existing.baseUrl)operator(actor,'credentials.write');
}

const operatorCommands=new Set(['save.provider',
  'guardrail.update','save.alert-rule','save.organization','save.member','import.members','save.definition','save.service','save.pool','save.plan','save.rule',
  'alert.ack','auto.apply','distribution.execute','entitlement.stop','entitlement.revoke','entitlements.migrate','project.fund','application.fund','project.reclaim','project.extend','application.reclaim','application.extend','settings.update','settings.retention','retention.run','periodic.run','usage.reconcile',
]);

/** Check current access before both previews and idempotent-result lookup.
 * Business state/amount validation stays in the action: a legitimate retry must not
 * execute it again or fail just because that action already changed its target state.
 */
export function authorizeCommand(state:WorkspaceState,actor:Member,command:PlatformCommand):void{
  const {type,payload:p}=command;
  const permission=commandPermissions[type];
  if(permission){operator(actor,permission);if(type==='save.service')authorizeServiceEndpoint(state,actor,command);authorizePricing(state,actor,command);return;}
  if(operatorCommands.has(type)){operator(actor);return;}
  switch(type){
    case 'save.project':{
      if(!p.id){operator(actor);return;}
      const project=manager(state,actor,p.id);
      if(!actor.roles.includes('operator')&&(p.range||p.managerId&&p.managerId!==project.managerId))throw new ForbiddenException('only operators may change manager or project model scope');return;
    }
    case 'save.application':{
      if(!p.id){operator(actor);return;}
      const application=owner(state,actor,p.id);
      if(p.completionChannelId!==undefined&&p.completionChannelId!==application.completionChannelId)operator(actor);
      if(!actor.roles.includes('operator')&&(p.range||p.ownerId&&p.ownerId!==application.ownerId))throw new ForbiddenException('operator required to change application range or owner');return;
    }
    case 'project.return':case 'project.members':case 'project.allocate':case 'project.end':manager(state,actor,p.projectId);return;
    case 'approval.submit':return; // The original applicant can still read their own submission history.
    case 'approval.withdraw':{
      if(pick(state.approvals,p.id,'approval').applicantId!==actor.id)throw new ForbiddenException('only applicant may withdraw');return;
    }
    case 'approval.decide':case 'approval.execute':case 'approval.repair':case 'approval.close':{
      const approval=pick(state.approvals,p.id,'approval');
      if(!canApprove(state,actor,approval))throw new ForbiddenException('not responsible for this approval, or self approval');
      if(type==='approval.execute'&&approval.approverId!==actor.id)throw new ForbiddenException('approval responsibility changed');return;
    }
    case 'key.issue':{
      if(p.purpose==='application')owner(state,actor,p.applicationId);
      else if(p.memberId&&p.memberId!==actor.id)operator(actor);return;
    }
    case 'key.status':case 'keys.status':statusKeys(state,actor,p,type==='keys.status');return;
    case 'notification.read':{
      if(pick(state.notifications,p.id,'notification').recipientId!==actor.id)throw new ForbiddenException('notification is outside actor scope');return;
    }
    default:throw new BadRequestException('unknown command');
  }
}
