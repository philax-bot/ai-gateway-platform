import 'reflect-metadata';
import 'dotenv/config';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import cors from '@fastify/cors';
import { AppModule } from './app.module';
import { DemoStore } from './store/demo.store';
import { WorkspaceRepository } from './platform/workspace.repository';
import {runtimeMode,validateRuntimeConfig} from '@ai-gateway/contracts';
import {trustedProxyAddress} from './http-proxy';

let startupPhase='configuration';
async function bootstrap(): Promise<void> {
  validateRuntimeConfig(process.env,'control-plane');
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: trustedProxyAddress(process.env.CONTROL_PLANE_TRUST_PROXY) }),
  );
  try {
    await app.register(cors, { origin: runtimeMode(process.env)==='production'?[process.env.WEB_ORIGIN!]:[process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173','http://localhost:5173'], credentials: true });
    app.enableShutdownHooks();
    startupPhase='database';await app.get(DemoStore).initialize();
    startupPhase='workspace';await app.get(WorkspaceRepository).initialize();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
    startupPhase='listen';await app.listen({
      host: process.env.HOST ?? '127.0.0.1',
      port: Number(process.env.PORT ?? 4001),
    });
  } catch (error) {
    await app.close();
    throw error;
  }
}

void bootstrap().catch((error:unknown)=>{const code=error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z0-9_]{1,40}$/.test(error.code)?error.code:'unavailable';console.error(`Control-plane startup failed (${startupPhase}, code=${code}). Check runtime configuration, database availability and migration compatibility. Secret values are not logged.`);process.exitCode=1;});
