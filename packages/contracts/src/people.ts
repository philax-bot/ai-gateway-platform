export type PersonScope='directory'|'onboarding'|'manager'|'owner'|'sponsor'|'project-members'|'project-allocation';
export interface PersonQuery {
  scope:PersonScope;projectId?:string;query?:string;organizationId?:string;includeChildren?:boolean;
  category?:'employee'|'contractor';page?:number;pageSize?:number;ids?:string[];excludeIds?:string[];
}
export interface PersonSummary {
  id:string;name:string;directoryId:string;organizationId:string;organizationPath:string;
  category:'employee'|'contractor';active:boolean;validUntil:string|null;selectable:boolean;unavailableReason:string|null;
}
export interface PersonPage {items:PersonSummary[];total:number;page:number;pageSize:number}
export interface PersonOrganizationQuery {scope:PersonScope;projectId?:string;parentId?:string|null;query?:string;page?:number;pageSize?:number}
export interface PersonOrganization {id:string;name:string;path:string;parentId:string|null;active:boolean;hasChildren:boolean}
export interface PersonOrganizationPage {items:PersonOrganization[];total:number;page:number;pageSize:number}
