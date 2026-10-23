import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

@Injectable()
export class ServiceTokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, string | undefined> }>();
    const authorization = request.headers.authorization ?? '';
    const expected = process.env.SERVICE_TOKEN ?? 'local-service-token';
    if (authorization !== `Bearer ${expected}`) {
      throw new UnauthorizedException('service token is required');
    }
    return true;
  }
}
