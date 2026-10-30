import { Module } from '@nestjs/common';
import { CallsController } from './calls/calls.controller';
import { GatewaySyncController } from './gateway/gateway-sync.controller';
import { GatewayService } from './gateway/gateway.service';
import { HigressProvider } from './gateway/higress.provider';
import { GatewaySyncRepository } from './gateway/gateway-sync.repository';
import { ServiceTokenGuard } from './security/service-token.guard';
import { PolicyController } from './policy/policy.controller';
import { PolicyService } from './policy/policy.service';
import { UsageController } from './usage/usage.controller';
import { UsageService } from './usage/usage.service';
import { DemoStore } from './store/demo.store';
import { PostgresStore } from './store/postgres.store';
import { HealthController } from './health/health.controller';
import { WorkspaceRepository } from './platform/workspace.repository';
import { AuthService } from './platform/auth.service';
import { AuthController } from './platform/auth.controller';
import { SessionGuard } from './platform/session.guard';
import { PlatformService } from './platform/platform.service';
import { PlatformController } from './platform/platform.controller';
import { MaintenanceService } from './platform/maintenance.service';
import { MonitoringService } from './platform/monitoring.service';
import { DiagnosticsController } from './store/diagnostics.controller';
import {AgentInstancesController} from './agents/agent-instances.controller';
import {AgentInstancesService} from './agents/agent-instances.service';
import {LocalOctopRuntime} from './agents/local-octop.runtime';
import {AgentChatService} from './agents/agent-chat.service';
import {LocalOctopImportService} from './agents/local-octop-import.service';
import {LocalOctopImportController} from './agents/local-octop-import.controller';

@Module({
  controllers: [PolicyController, UsageController, GatewaySyncController, CallsController, HealthController, AuthController, PlatformController, DiagnosticsController,AgentInstancesController,LocalOctopImportController],
  providers: [
    { provide: DemoStore, useClass: process.env.STORE_MODE === 'memory' ? DemoStore : PostgresStore },
    PolicyService,
    UsageService,
    GatewayService,
    HigressProvider,
    GatewaySyncRepository,
    ServiceTokenGuard,
    WorkspaceRepository,
    AuthService,
    SessionGuard,
    PlatformService,
    MaintenanceService,
    MonitoringService,
    AgentInstancesService,
    LocalOctopRuntime,
    AgentChatService,
    LocalOctopImportService,
  ],
})
export class AppModule {}
