import {hasPermission,type Member,type Permission} from '@ai-gateway/contracts';

const pagePermissions:Record<string,Permission>={
  overview:'administration.manage',
  usage:'usage.read.all',leaderboard:'usage.read.all',
  'cockpit-light':'usage.read.all','cockpit-tech':'usage.read.all','cockpit-beacon':'usage.read.all',
  onboarding:'administration.manage',plans:'administration.manage',approvals:'finance.read',projects:'finance.read',applications:'finance.read',
  catalog:'models.read',providers:'models.read',models:'models.read',pools:'models.read',capacity:'models.read',
  members:'administration.manage',keys:'audit.read',monitoring:'monitoring.read',
  'media-tasks':'monitoring.read',safety:'security.read',calls:'calls.read.all',reviews:'finance.read',settings:'audit.read',
};

export function operationsPages(actor:Member){
  const allowed=(page:string)=>hasPermission(actor,pagePermissions[page]);
  return {
    primary:['overview','usage','leaderboard','cockpit-light','cockpit-tech','cockpit-beacon','onboarding','plans','approvals','projects','applications'].filter(allowed),
    models:['catalog','providers','models','pools','capacity'].filter(allowed),
    secondary:['members','keys','monitoring','media-tasks','safety','calls','reviews','settings'].filter(allowed),
  };
}

export function operationsLanding(actor:Member){
  if(hasPermission(actor,'administration.manage'))return 'overview';
  if(hasPermission(actor,'monitoring.write'))return 'monitoring';
  return 'usage';
}
