import {describe,expect,it,vi} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {MonitoringService} from './monitoring.service';
import {MaintenanceService} from './maintenance.service';
import {Module} from '@nestjs/common';
import {NestFactory} from '@nestjs/core';
import {FastifyAdapter} from '@nestjs/platform-fastify';

describe('idle maintenance does not acquire the admission workspace write lock',()=>{
  it('lets Nest finish initialization while initial monitoring is stalled',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store),maintenance=new MaintenanceService(repo,store,monitor);
    let enter!:()=>void,release!:()=>void;
    const entered=new Promise<void>(resolve=>{enter=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    vi.spyOn(monitor,'evaluate').mockImplementation(async()=>{enter();await gate;return {evaluated:0,collectionQuality:'collected' as const};});
    @Module({providers:[{provide:MaintenanceService,useValue:maintenance}]})
    class StartupCheckModule{}
    const app=await NestFactory.create(StartupCheckModule,new FastifyAdapter(),{logger:false});
    let timer:ReturnType<typeof setTimeout>|undefined;
    const initialized=app.init();
    try{
      await entered;
      await Promise.race([initialized,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('monitoring blocked Nest initialization')),1000);})]);
      expect(maintenance.status().running).toBe(true);
    }finally{clearTimeout(timer);release();await maintenance.run();await initialized;await app.close();}
  });
  it('skips write transactions after the current monitoring minute has been collected',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),monitor=new MonitoringService(repo,store),maintenance=new MaintenanceService(repo,store,monitor);
    await maintenance.run();const before=await repo.read(),write=vi.spyOn(repo,'transact');
    await maintenance.run();expect(write).not.toHaveBeenCalled();expect(await repo.read()).toEqual(before);
  });
  it('rechecks retention policy under the write lock when work was due at the read snapshot',async()=>{
    const store=new DemoStore(),repo=new WorkspaceRepository(store),maintenance=new MaintenanceService(repo,store);
    await repo.transact(async tx=>{tx.state.settings.retentionAutomatic=true;});
    const transact=repo.transact.bind(repo);let entered=0;
    repo.transact=async(work,options)=>{entered++;await transact(async tx=>{tx.state.settings.retentionAutomatic=false;});return transact(work,options);};
    await maintenance.run();expect(entered).toBe(1);expect((await repo.read()).retention).toBeUndefined();
  });
});
