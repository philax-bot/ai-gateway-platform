import {open,readFile} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import {userInfo} from 'node:os';

export async function developmentCredentialKey(root,configured){
  if(configured)return configured;
  const path=resolve(root,'.runtime','upstream-credential-key');
  try{
    const existing=(await readFile(path,'utf8')).trim();
    if(!/^[A-Za-z0-9+/]{43}=$/.test(existing))throw new Error('本地凭据加密密钥文件格式无效，请检查原文件');
    return existing;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const file=await open(path,'wx',0o600);
  try{
    if(process.platform==='win32'){
      const account=process.env.USERDOMAIN?`${process.env.USERDOMAIN}\\${userInfo().username}`:userInfo().username;
      execFileSync('icacls.exe',[path,'/inheritance:r','/grant:r',`${account}:(F)`],{windowsHide:true,stdio:'pipe'});
    }
    const key=randomBytes(32).toString('base64');await file.writeFile(key,'utf8');return key;
  }finally{await file.close();}
}
