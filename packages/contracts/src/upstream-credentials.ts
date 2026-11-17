export interface UpstreamCredentialVersion {
  version:number;createdAt:string;masked:string;
  ciphertext?:string;iv?:string;tag?:string;
}
export interface UpstreamCredential {
  id:string;providerId:string;name:string;active:boolean;currentVersion:number;
  /* Set when the secret belongs to exactly one service ("自定义密钥，仅用于当前模型服务"):
     it is never listed as a reusable credential and never shares with other services. */
  serviceId?:string|null;
  createdAt:string;updatedAt:string;versions:UpstreamCredentialVersion[];
}
export interface FrozenCredential {id:string;version:number}
export type PublicUpstreamCredential=Omit<UpstreamCredential,'versions'>&{versions:Pick<UpstreamCredentialVersion,'version'|'createdAt'|'masked'>[]};
