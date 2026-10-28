import {describe,expect,it,vi} from 'vitest';
import {DemoStore} from '../store/demo.store';
import {WorkspaceRepository} from './workspace.repository';
import {MonitoringService} from './monitoring.service';
import {MaintenanceService} from './maintenance.service';

describe('idle maintenance does not acquire the admission workspace write lock',()=>{
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
