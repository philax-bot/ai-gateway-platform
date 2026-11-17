import {afterEach,describe,expect,it,vi} from 'vitest';
import type {ModelKind} from '@ai-gateway/contracts';
import {initialWorkspace} from './seed';
import {DemoStore} from '../store/demo.store';
import {runModelAcceptance} from './model-acceptance';

afterEach(()=>vi.unstubAllGlobals());
describe('bounded actual model acceptance',()=>{
  function setup(kind:ModelKind){
    const state=initialWorkspace(),definition=state.definitions[0],service=state.services[0];
    definition.kind=kind;
    const mapping=service.mappings[0];mapping.costPrice={inputPrice:1,outputPrice:2,cachedInputPrice:0};
    const unit=kind==='image'?'per_image':kind==='asr'?'per_second':kind==='tts'?'per_1000_characters':'per_request';
    if(kind!=='chat'&&kind!=='embeddings')mapping.meter={unit,price:0.2,costPrice:0.1,estimatedUnits:1,maxUnits:1000};
    return {state,definition,service,store:new DemoStore()};
  }
  it.each(['embeddings','rerank','image','asr','tts'] as ModelKind[])('records a real %s response and authoritative modality usage',async kind=>{
    const {state,definition,service,store}=setup(kind);
    const send=vi.fn(async(_url:unknown,init:RequestInit)=>{
      if(kind==='asr')expect(init.body).toBeInstanceOf(FormData);
      if(kind==='tts')return new Response('RIFF-fixture',{headers:{'content-type':'audio/wav'}});
      const result=kind==='embeddings'?{data:[{embedding:[0.1,0.2]}],usage:{prompt_tokens:12,total_tokens:12}}:
        kind==='rerank'?{results:[{index:0,relevance_score:0.9}]}:kind==='asr'?{text:'fixture',duration:2.5}:{data:[{b64_json:'fixture'}]};
      return new Response(JSON.stringify(result),{headers:{'content-type':'application/json'}});
    });
    vi.stubGlobal('fetch',send);
    const input={definitionId:definition.id,probe:'actual',maxCost:1,idempotencyKey:crypto.randomUUID()};
    const result=await runModelAcceptance(state,store,'operator-demo-001',service.id,input);
    expect(result.run.results[0]).toMatchObject({outcome:'passed',usage:{complete:true},cost:{state:'priced'}});
    expect(result.run.results[0].cost.amount).toBeGreaterThan(0);
    expect((await runModelAcceptance(state,store,'operator-demo-001',service.id,input)).replayed).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    await expect(runModelAcceptance(state,store,'operator-demo-001',service.id,{...input,probe:'basic'})).rejects.toMatchObject({status:400});
  });
  it('refuses an over-budget request before any upstream dispatch',async()=>{
    const {state,definition,service,store}=setup('image'),send=vi.fn();vi.stubGlobal('fetch',send);
    await expect(runModelAcceptance(state,store,'operator-demo-001',service.id,{definitionId:definition.id,probe:'actual',maxCost:0,idempotencyKey:crypto.randomUUID()})).rejects.toThrow('exceeds cap');
    expect(send).not.toHaveBeenCalled();
  });
  it('explains how to complete legacy missing costs before dispatch',async()=>{
    const {state,definition,service,store}=setup('chat'),send=vi.fn();vi.stubGlobal('fetch',send);
    service.mappings[0].costPrice=null;
    await expect(runModelAcceptance(state,store,'operator-demo-001',service.id,{definitionId:definition.id,probe:'basic',maxCost:0.1,idempotencyKey:crypto.randomUUID()})).rejects.toThrow('调整计价');
    expect(send).not.toHaveBeenCalled();
  });
});
