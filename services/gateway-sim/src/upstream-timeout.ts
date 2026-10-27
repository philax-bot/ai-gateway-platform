export interface GatewayTimeouts {
  totalMs: number;
  firstByteMs: number;
  idleMs: number;
  drainMs: number;
}

export function gatewayTimeouts(env: Record<string, string | undefined>): GatewayTimeouts {
  const read = (key: string, fallback: number) => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < 100 || value > 3_600_000) {
      throw new Error(`${key} must be an integer between 100 and 3600000 milliseconds`);
    }
    return value;
  };
  return {
    // Existing UPSTREAM_TIMEOUT_MS remains the total request budget.
    totalMs: read('UPSTREAM_TIMEOUT_MS', 600_000),
    firstByteMs: read('UPSTREAM_FIRST_BYTE_TIMEOUT_MS', 120_000),
    idleMs: read('UPSTREAM_IDLE_TIMEOUT_MS', 60_000),
    drainMs: read('GATEWAY_DRAIN_TIMEOUT_MS', 35_000),
  };
}

export type TimeoutPhase = 'first_byte' | 'idle' | 'total';

/** Activity renews only the idle budget; it can never extend the total deadline. */
export class UpstreamDeadline {
  phase: TimeoutPhase | null = null;
  private total: ReturnType<typeof setTimeout>;
  private activity: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(private readonly controller: AbortController, private readonly config: GatewayTimeouts) {
    this.total = setTimeout(() => this.expire('total'), config.totalMs);
    this.activity = setTimeout(() => this.expire('first_byte'), config.firstByteMs);
    this.total.unref();
    this.activity.unref();
  }

  receivedBytes() {
    if (this.stopped || this.controller.signal.aborted) return;
    clearTimeout(this.activity);
    this.activity = setTimeout(() => this.expire('idle'), this.config.idleMs);
    this.activity.unref();
  }

  private expire(phase: TimeoutPhase) {
    if (this.stopped || this.controller.signal.aborted) return;
    this.phase = phase;
    this.controller.abort();
    this.stop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.total);
    clearTimeout(this.activity);
  }
}
