import {BadRequestException,ForbiddenException} from '@nestjs/common';
import type {Member,PlatformCommand,WorkspaceState} from '@ai-gateway/contracts';
import {canApprove,manager,owner} from './domain';
import {operator,pick} from './validation';
import {statusKeys} from './key-status';

const operatorCommands=new Set([
  'save.alert-rule','save.organization','save.member','import.members','save.definition','save.service','save.pool','save.plan','save.rule',
  'alert.ack','auto.apply','distribution.execute','entitlement.stop','entitlement.revoke','entitlements.migrate','project.fund','application.fund','settings.update','settings.retention','retention.run','periodic.run','usage.reconcile',
]);

/** Check current access before both previews and idempotent-result lookup.
 * Business state/amount validation stays in the action: a legitimate retry must not
 * execute it again or fail just because that action already changed its target state.
 */
export function authorizeCommand(state:WorkspaceState,actor:Member,command:PlatformCommand):void{
  const {type,payload:p}=command;
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
      if(!actor.roles.includes('operator')&&(p.range||p.ownerId&&p.ownerId!==application.ownerId))throw new ForbiddenException('operator required to change application range or owner');return;
    }
    case 'project.members':case 'project.allocate':case 'project.end':manager(state,actor,p.projectId);return;
    case 'approval.submit':return; // The original applicant can still read their own submission history.
    case 'approval.withdraw':{
      if(pick(state.approvals,p.id,'approval').applicantId!==actor.id)throw new ForbiddenException('only applicant may withdraw');return;
    }
    case 'approval.decide':case 'approval.execute':case 'approval.repair':{
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
