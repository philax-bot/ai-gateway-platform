export interface RetentionCounts {notifications:number;alerts:number;collectionAlerts:number;sessions:number}
export interface RetentionRun {
  id:string;executedAt:string;checkedAt:string;cutoff:string;days:number;source:'manual'|'automatic';actorId:string;removed:RetentionCounts;
}
export interface RetentionReport {
  days:number;automatic:boolean;checkedAt:string;cutoff:string;fingerprint:string;eligible:RetentionCounts;
  protected:{unreadNotifications:number;unfinishedNotifications:number;activeAlerts:number;activeSessions:number};
  lastRun:RetentionRun|null;
}
