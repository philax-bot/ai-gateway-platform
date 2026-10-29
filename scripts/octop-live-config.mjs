import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {estimateChatInput} from '../packages/contracts/dist/index.js';

export class LiveBudget {
  constructor(price,maxRequests=12,maxAmount=1){this.price=price;this.maxRequests=maxRequests;this.maxAmount=maxAmount;this.attempts=0;this.upper=0;}
  reserve(body){
    const max=body.max_completion_tokens??body.max_tokens;
    assert.ok(Number.isSafeInteger(max)&&max>=1&&max<=1024,'live output must be explicitly bounded to 1024 tokens');
    const upper=(estimateChatInput(body)*Math.max(this.price.inputPrice,this.price.cachedInputPrice)+max*this.price.outputPrice)/1e6;
    assert.ok(Number.isFinite(upper)&&upper>=0,'live price estimate must be finite');
    assert.ok(this.attempts<this.maxRequests&&this.upper+upper<=this.maxAmount,'live request or configured-price budget exhausted');
    this.attempts++;this.upper+=upper;return upper;
  }
  snapshot(){return {maxRequests:this.maxRequests,maxEstimatedAmount:this.maxAmount,attempts:this.attempts,estimatedUpperBound:this.upper};}
}

export async function loadLiveConfig(root){
  const require=createRequire(resolve(root,'apps/control-plane/package.json')),{parse}=require('dotenv'),{Pool}=require('pg');
  const env=parse(await readFile(resolve(root,'.env'))),dbEnv=parse(await readFile(resolve(root,'apps/control-plane/.env'))),review=JSON.parse(await readFile(resolve(root,'.runtime/review-postgres.json')));
  assert.match(review.schema,/^agp_review_[a-f0-9]{32}$/);
  const db=new Pool({connectionString:dbEnv.DATABASE_URL,connectionTimeoutMillis:5000});let definition,service,mapping;
  try{
    const row=(await db.query(`select payload->'services' as services,payload->'definitions' as definitions from "${review.schema}".platform_workspace where id=$1`,['org-demo'])).rows[0];
    definition=row.definitions.find(d=>d.modelId==='deepseek-flash');assert.ok(definition,'review DeepSeek definition is required');
    service=row.services.find(s=>new URL(s.baseUrl).hostname==='api.deepseek.com'&&s.mappings.some(m=>m.definitionId===definition.id));assert.ok(service,'official DeepSeek route is required');
    mapping=service.mappings.find(m=>m.definitionId===definition.id);
  }finally{await db.end();}
  assert.match(service.credentialRef,/^UPSTREAM_[A-Z0-9_]+$/);assert.ok(env[service.credentialRef],'controlled upstream credential is required');
  assert.ok([mapping.inputPrice,mapping.outputPrice,mapping.cachedInputPrice].every(p=>typeof p==='number'&&Number.isFinite(p)&&p>=0),'configured prices must be known');
  const target=new URL(service.baseUrl);assert.ok(target.protocol==='https:'&&!target.username&&!target.password&&!target.search&&!target.hash);
  return {definition,service,mapping,credential:env[service.credentialRef]};
}
