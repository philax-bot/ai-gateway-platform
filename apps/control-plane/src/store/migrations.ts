import {createHash} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import type {PoolClient} from 'pg';
export interface Migration {version:number;name:string;sql:string;checksum:string}
export function loadMigrations(directory:string):Migration[]{
  const files=readdirSync(directory).filter(name=>name.endsWith('.sql'));
  const migrations=files.map(name=>{const match=/^(\d{3,})_[a-z0-9_]+\.sql$/.exec(name);if(!match)throw new Error('Invalid migration filename');const sql=readFileSync(resolve(directory,name),'utf8').replace(/\r\n/g,'\n'),version=Number(match[1]);if(!Number.isSafeInteger(version)||version<1)throw new Error('Invalid migration version');return {version,name,sql,checksum:createHash('sha256').update(sql).digest('hex')};}).sort((a,b)=>a.version-b.version);
  if(!migrations.length||new Set(migrations.map(m=>m.version)).size!==migrations.length)throw new Error('Migrations must have unique numeric versions');
  return migrations;
}
/** Caller owns the transaction. The schema-scoped lock and DDL/data/ledger commit atomically. */
export async function applyMigrations(client:PoolClient,migrations:Migration[]){
  await client.query("select pg_advisory_xact_lock(hashtextextended(current_database()||':'||current_schema()||':control-plane-migrations',0))");
  await client.query(`create table if not exists schema_migrations(version integer primary key,name text unique not null,checksum text not null,applied_at timestamptz not null default now())`);
  const prior=(await client.query<{version:number;name:string;checksum:string}>('select version,name,checksum from schema_migrations order by version')).rows;
  for(const row of prior){const migration=migrations.find(m=>m.version===row.version);if(!migration)throw new Error(`Database migration ${row.version} is newer than or absent from this release`);if(row.name!==migration.name||row.checksum!==migration.checksum)throw new Error(`Applied migration changed: ${migration.name}`);}
  const latest=prior.at(-1)?.version??0;let applied=0;
  for(const migration of migrations){if(prior.some(row=>row.version===migration.version))continue;if(migration.version<latest)throw new Error(`Migration inserted before applied history: ${migration.name}`);await client.query(migration.sql);await client.query('insert into schema_migrations(version,name,checksum) values($1,$2,$3)',[migration.version,migration.name,migration.checksum]);applied++;}
  return {applied,total:migrations.length};
}
