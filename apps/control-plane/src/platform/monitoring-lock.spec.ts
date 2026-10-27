import {describe,it,expect} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {MonitoringService} from './monitoring.service';
import {saveAlertRule} from './monitoring.domain';

describe('monitor collection does not hold the admission workspace lock',()=>{
  it('admits requests while a statistics query is stalled',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store);
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const query=store.queryCalls.bind(store);store.queryCalls=async(...args)=>{enter();await gate;return query(...args);};
    const evaluation=monitor.evaluate(true);await entered;
    let deadline:ReturnType<typeof setTimeout>|undefined;
    try{
      const credential=store.credentials.get('local-employee-key')!,id=crypto.randomUUID();
      const admitted=await Promise.race([store.authorize({requestId:id,idempotencyKey:id,identity:credential.identity,purpose:'personal',modelId:'test-model',mode:'chat',policyVersion:'lock-test'}),new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('monitor held the admission lock')),1000);})]);
      expect(admitted.decision).toBe('allow');
    }finally{if(deadline)clearTimeout(deadline);release();await evaluation;}
  });
  it('discards a sampled rule version changed during collection and evaluates the new version next time',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store);
    const input={name:'slow sample',metric:'request_error_rate',windowMinutes:10,threshold:10,minSamples:1,triggerCount:1,recoveryThreshold:5,recoveryCount:1};
    const rule=await repo.transact(async tx=>saveAlertRule(tx.state,input));
    let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const query=store.queryCalls.bind(store);store.queryCalls=async(q,...args)=>{if(Date.parse(q.to!)-Date.parse(q.from!)===600000){enter();await gate;}return query(q,...args);};
    const evaluation=monitor.evaluate(true);await entered;
    try{await repo.transact(async tx=>saveAlertRule(tx.state,{...input,id:rule.id,name:'new version'}));}finally{release();}
    await evaluation;expect((await repo.read()).monitoring!.evaluations[rule.id]).toBeUndefined();
    await monitor.evaluate();expect((await repo.read()).monitoring!.evaluations[rule.id].ruleVersion).toBe(2);
  });
});
