import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHmac} from 'node:crypto';
import type {AdmissionSnapshot,AlertRule,CapacitySnapshot} from '@ai-gateway/contracts';
import {DemoStore} from '../store/demo.store';
import {rankRoutes,recordRoutingOutcome} from '../store/pool-routing';
import {WorkspaceRepository} from './workspace.repository';
import {simulatePoolRouting} from './routing-simulation';
import {operationalReading} from './operational-metrics';
import {saveAlertRule,applyAlertReading} from './monitoring.domain';
import {initialWorkspace} from './seed';
import {saveWebhookChannel,enqueueAlertWebhooks,deliverWebhooks} from './webhook-notifications';

const ruleBase={name:'capacity',metric:'rpm_utilization' as const,windowMinutes:5,threshold:80,minSamples:20,triggerCount:1,recoveryThreshold:50,recoveryCount:1};
afterEach(()=>{vi.useRealTimers();delete process.env.NOTIFICATION_TEST_KEY;});

describe('routing explanations and read-only simulation',()=>{
  it('simulates changed priority against real counters without writing business state or money',async()=>{
    const store=new DemoStore(),repository=new WorkspaceRepository(store);await repository.initialize();
    await repository.transact(async tx=>{
      const state=tx.state,service=state.services[0];service.verification='passed';
      service.limits={mode:'custom',concurrency:1};
      state.services.push({...structuredClone(service),id:'second',name:'Second',limits:{mode:'none'}});
      state.pools[0].entries=[{serviceId:service.id,definitionId:state.definitions[0].id,open:true,priority:0},{serviceId:'second',definitionId:state.definitions[0].id,open:true,priority:1}];
    });
    const funds=structuredClone([...store.quotaBatches]);
    const before=await repository.read(),pool=before.pools[0],first=before.services[0];
    vi.spyOn(store,'capacityCounters').mockResolvedValue({collectedAt:new Date().toISOString(),windowStart:new Date().toISOString(),windowEnd:new Date().toISOString(),rows:[{scopeId:`${before.tenantId}:service:${first.id}`,requests:0,tokens:0,active:1}]});
    const result=await simulatePoolRouting(before,store,pool.id,{modelId:before.definitions[0].modelId,maxOutputTokens:1,routing:{strategy:'priority',failureThreshold:0,cooldownSeconds:30}});
    expect(result.decision.selectedServiceId).toBe('second');
    expect(result.decision.candidates?.find(row=>row.serviceId===first.id)).toMatchObject({status:'capacity',reason:'admission_limit_reached'});
    expect(result.decision.candidates?.find(row=>row.serviceId==='second')).toMatchObject({status:'selected',rank:2});
    expect(await repository.read()).toEqual(before);
    expect([...store.quotaBatches]).toEqual(funds);
  });

  it('retains cold candidates and their reason in the selected decision',()=>{
    const state=initialWorkspace(),pool=state.pools[0];pool.routing={strategy:'priority',failureThreshold:2,cooldownSeconds:30};
    const choices:{admission:AdmissionSnapshot}[]=['one','two'].map(serviceId=>({admission:{kind:'configured' as const,price:null,reservedAmount:0,estimatedTokens:0,scopes:[],route:{serviceId,definitionId:'d',poolId:pool.id,baseUrl:'http://localhost',upstreamModel:'physical',credentialRef:null}}}));
    pool.entries=choices.map(choice=>({serviceId:choice.admission.route!.serviceId,definitionId:'d',open:true}));
    const ranked=rankRoutes(choices,state,[],[{serviceId:'one',definitionId:'d',failures:2,recent:2,failedAt:Date.now(),samples:0,latency:null}],'request');
    recordRoutingOutcome(ranked[0].admission,'selected');
    expect(ranked[0].admission.routing?.candidates?.map(row=>row.status)).toEqual(['cooldown','selected']);
    expect(ranked[0].admission.routing?.candidateCount).toBe(2);
  });
});

describe('operational alert evidence',()=>{
  it('uses utilization percentages and never treats an unlimited or missing denominator as recovery',()=>{
    const state=initialWorkspace(),rule=saveAlertRule(state,ruleBase);
    const capacity:CapacitySnapshot={collectedAt:new Date().toISOString(),windowStart:'start',windowEnd:'end',quality:'collected',rows:[{scopeId:'service:one',kind:'service',resourceId:'one',name:'one',modelId:null,enabled:true,inherited:false,rpm:{used:9,limit:10,percent:90},tpm:{used:0,limit:null,percent:null},concurrency:{used:0,limit:1,percent:0}}]};
    const hot=operationalReading(rule,'from','to',null,capacity,null);expect(hot).toMatchObject({quality:'ready',value:90,unit:'%'});
    applyAlertReading(state,rule,hot,1);expect(state.monitoring?.events[0].status).toBe('active');
    capacity.rows[0].poolIds=['original-pool'];
    expect(operationalReading({...rule,poolId:'original-pool',serviceId:'one'},'from','to',null,capacity,null).value).toBe(90);
    capacity.rows[0].poolIds=['different-pool'];
    expect(operationalReading({...rule,poolId:'original-pool',serviceId:'one'},'from','to',null,capacity,null).quality).toBe('insufficient');
    capacity.rows[0].rpm={used:0,limit:null,percent:null};
    const unknown=operationalReading(rule,'from','to',null,capacity,null);expect(unknown.quality).toBe('insufficient');
    applyAlertReading(state,rule,unknown,2);expect(state.monitoring?.events[0].status).toBe('active');
    const backlogRule:AlertRule={...rule,metric:'media_backlog',threshold:3,recoveryThreshold:1};
    expect(operationalReading(backlogRule,'from','to',null,null,{collectedAt:'at',media:{count:0,oldestSeconds:0},settlement:{count:0,oldestSeconds:0}})).toMatchObject({quality:'ready',value:0,unit:'条'});
  });
  it('keeps silenced events and audit evidence without notifying users or webhooks',()=>{
    const state=initialWorkspace(),rule=saveAlertRule(state,ruleBase);
    saveWebhookChannel(state,{name:'local',url:'http://127.0.0.1/hook',signingKeyRef:'NOTIFICATION_TEST_KEY'});
    rule.silencedUntil=new Date(Date.now()+3600000).toISOString();
    const before=state.notifications.length;
    applyAlertReading(state,rule,{ruleId:rule.id,from:'from',to:'to',collectedAt:new Date().toISOString(),quality:'ready',value:90,sampleCount:1,numerator:9,denominator:10},1);
    expect(state.monitoring?.events).toHaveLength(1);expect(state.audit.at(-1)?.action).toBe('alert.opened');
    expect(state.notifications).toHaveLength(before);expect(state.monitoring?.deliveries??[]).toHaveLength(0);
  });
});

describe('durable signed webhook outbox',()=>{
  it('queues future-dated samples immediately, deduplicates events, claims across workers and signs retries',async()=>{
    vi.useFakeTimers();process.env.NOTIFICATION_TEST_KEY='k'.repeat(32);
    const repository=new WorkspaceRepository(new DemoStore());await repository.initialize();
    await repository.transact(async tx=>{
      saveWebhookChannel(tx.state,{name:'local',url:'http://127.0.0.1/hook',signingKeyRef:'NOTIFICATION_TEST_KEY'});
      for(let i=0;i<2;i++)enqueueAlertWebhooks(tx.state,'alert-one','alert.opened',new Date(Date.now()+10000).toISOString(),null,'local','fixture');
    });
    const sent:{body:string;headers:Record<string,string>}[]=[];
    const send=vi.fn(async(_url:unknown,init:any)=>{sent.push({body:init.body,headers:init.headers});return new Response('',{status:sent.length===1?503:200});}) as unknown as typeof fetch;
    await Promise.all([deliverWebhooks(repository,send),deliverWebhooks(repository,send)]);
    expect(sent).toHaveLength(1);expect((await repository.read()).monitoring?.deliveries?.[0]).toMatchObject({status:'pending',attempts:1,lastError:'http_503'});
    vi.setSystemTime(Date.now()+61000);await deliverWebhooks(repository,send);
    const delivery=(await repository.read()).monitoring?.deliveries?.[0];expect(delivery).toMatchObject({status:'succeeded',attempts:2});
    expect(sent[0].headers['X-Gateway-Event-Id']).toBe(sent[1].headers['X-Gateway-Event-Id']);
    for(const request of sent){const signature=createHmac('sha256',process.env.NOTIFICATION_TEST_KEY!).update(`${request.headers['X-Gateway-Timestamp']}.${request.body}`).digest('hex');expect(request.headers['X-Gateway-Signature']).toBe(`sha256=${signature}`);}
  });
});
