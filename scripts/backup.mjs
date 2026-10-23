import {backupWorkspace,connectionConfig,restoreWorkspace} from './lib/backup.mjs';
const args=process.argv.slice(2),mode=args.shift();
function argumentsFor(mode){
  const allowed=mode==='backup'?new Set(['--out','--journal']):new Set(['--from','--journal-root']),values=new Map();
  for(let i=0;i<args.length;i++){
    const name=args[i];if(name==='--')continue;
    if(!allowed.has(name))throw new Error('Unknown argument; use --help for supported options');
    if(!args[i+1]||args[i+1].startsWith('--'))throw new Error(`${name} requires a value`);
    if(values.has(name)&&name!=='--journal')throw new Error(`${name} may only be supplied once`);
    values.set(name,[...(values.get(name)||[]),args[++i]]);
  }
  return (name,multiple=false)=>multiple?(values.get(name)||[]):values.get(name)?.[0];
}
if(args.includes('--help')||mode==='--help'||!mode){console.log('backup: pnpm backup -- --out <new-directory> --journal <stopped-gateway-journal> [--journal <other-journal>]\nrestore: pnpm restore -- --from <backup-directory> --journal-root <new-directory>\nDATABASE_URL / DATABASE_SCHEMA are read privately from the environment or control-plane .env; PG_BIN can name an absolute client-tools directory.');}
else try{
  if(!['backup','restore'].includes(mode))throw new Error('Use backup or restore');
  const argument=argumentsFor(mode);
  const config=await connectionConfig();
  if(mode==='backup'){
    const destination=argument('--out'),journals=argument('--journal',true);if(!destination)throw new Error('--out is required');
    const result=await backupWorkspace({...config,destination,journals});console.log(`Backup completed: ${result.directory}\nSchema: ${result.manifest.schema}; gateway journals: ${result.manifest.journals.length}. Protect this bundle as application data.`);
  }else if(mode==='restore'){
    const source=argument('--from'),journalRoot=argument('--journal-root');if(!source||!journalRoot)throw new Error('--from and --journal-root are required');
    const result=await restoreWorkspace({...config,source,journalRoot});console.log(`Restore completed: schema ${result.schema}\n${result.journals.map(j=>`${j.id}: ${j.directory}`).join('\n')}\nUse the matching installation mode and persistent journal directories before starting services.`);
  }else throw new Error('Use backup or restore');
}catch(error){console.error(error instanceof Error&&/^(DATABASE_URL|DATABASE_SCHEMA|Invalid |An explicit|A PostgreSQL|PG_BIN|pg_dump|pg_restore|Destination|Supply |Journal |Source |Configured |Duplicate |Backup |Target |Database restored|Unsupported |Unknown |Use |--)/.test(error.message)?error.message:'Backup/restore failed; check the connection, schema, filesystem and trusted backup bundle. No connection secrets are logged.');process.exitCode=1;}
