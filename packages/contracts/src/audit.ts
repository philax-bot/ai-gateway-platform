export interface AuditQuery {search?:string;actorId?:string;action?:string;from?:string;to?:string;cursor?:string;limit?:number}
export interface AuditRecord {
  id:string;createdAt:string;actorId:string;actorName:string;action:string;actionName:string;
  objectId:string|null;objectName:string;objectNameSource:'recorded'|'current'|'unavailable';reason:string;
  summary:{label:string;value:string}[];
}
export interface AuditPage {
  items:AuditRecord[];total:number;nextCursor:string|null;collectedAt:string;
  actors:{id:string;name:string}[];actions:{id:string;name:string}[];
}
