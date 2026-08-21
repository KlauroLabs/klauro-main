const DEFAULT_ACTIVE_ANALYSES = 1;
const DEFAULT_QUEUED_ANALYSES = 4;
const MAX_QUEUED_ANALYSES = 32;
const DEFAULT_ESTIMATED_JOB_MS = 120_000;

export interface HostedAnalysisCapacity {
  activeLimit: number;
  queueLimit: number;
}

export interface HostedAnalysisQueueState {
  active: number;
  queued: number;
  active_limit: number;
  queue_limit: number;
}

export interface HostedAnalysisAdmissionMetadata extends HostedAnalysisQueueState {
  queue_position: number;
  estimated_wait_ms: number;
}

export interface HostedAnalysisOverload extends HostedAnalysisQueueState {
  status: 'overloaded';
  code: 'analysis_capacity_exhausted';
  retry_after_ms: number;
}

interface ScheduledTicket {
  id: number;
  task?: () => Promise<unknown>;
  onPosition?: (metadata: HostedAnalysisAdmissionMetadata) => void;
  resolve?: (value: unknown) => void;
  reject?: (error: unknown) => void;
  cancelled: boolean;
}

export interface HostedAnalysisTicket {
  readonly id: number;
  readonly metadata: HostedAnalysisAdmissionMetadata;
  cancel(): void;
}

export type HostedAnalysisAdmission =
  | { admitted: true; ticket: HostedAnalysisTicket }
  | { admitted: false; overload: HostedAnalysisOverload };

export class HostedAnalysisCapacityError extends Error {
  constructor(readonly overload: HostedAnalysisOverload) {
    super(`Hosted analysis capacity exhausted (${overload.active} active, ${overload.queued} queued).`);
    this.name = 'HostedAnalysisCapacityError';
  }
}

function positiveInteger(raw: string | undefined, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(maximum, Math.floor(parsed)) : fallback;
}

function nonNegativeInteger(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function resolveHostedAnalysisCapacity(
  env: NodeJS.ProcessEnv = process.env,
): HostedAnalysisCapacity {
  return {
    activeLimit: DEFAULT_ACTIVE_ANALYSES,
    queueLimit: Math.min(
      MAX_QUEUED_ANALYSES,
      nonNegativeInteger(env.KLAURO_ANALYSIS_QUEUE_CAPACITY, DEFAULT_QUEUED_ANALYSES),
    ),
  };
}

class HostedAnalysisScheduler {
  private running = 0;
  private nextId = 1;
  private waiting: ScheduledTicket[] = [];
  private recentDurations: number[] = [];

  reserve(): HostedAnalysisAdmission {
    const capacity = resolveHostedAnalysisCapacity();
    if (this.running + this.waiting.length >= capacity.activeLimit + capacity.queueLimit) {
      const state = this.state(capacity);
      return {
        admitted: false,
        overload: {
          status: 'overloaded',
          code: 'analysis_capacity_exhausted',
          ...state,
          retry_after_ms: this.estimatedDurationMs(),
        },
      };
    }
    const ticket: ScheduledTicket = {
      id: this.nextId++,
      cancelled: false,
    };
    this.waiting.push(ticket);
    this.notifyPositions(capacity);
    return {
      admitted: true,
      ticket: {
        id: ticket.id,
        metadata: this.metadataFor(ticket, capacity),
        cancel: () => this.cancel(ticket),
      },
    };
  }

  execute<T>(
    publicTicket: HostedAnalysisTicket,
    task: () => Promise<T>,
    onPosition?: (metadata: HostedAnalysisAdmissionMetadata) => void,
  ): Promise<T> {
    const ticket = this.waiting.find(candidate => candidate.id === publicTicket.id);
    if (!ticket || ticket.cancelled || ticket.task) return Promise.reject(new Error('Hosted analysis admission ticket is no longer active.'));
    ticket.task = task;
    ticket.onPosition = onPosition;
    const result = new Promise<T>((resolve, reject) => {
      ticket.resolve = resolve as (value: unknown) => void;
      ticket.reject = reject;
    });
    this.drain();
    return result;
  }

  reset(): void {
    for (const ticket of this.waiting) ticket.reject?.(new Error('Hosted analysis scheduler reset.'));
    this.waiting = [];
    this.running = 0;
    this.recentDurations = [];
  }

  snapshot(): HostedAnalysisQueueState {
    return this.state(resolveHostedAnalysisCapacity());
  }

  private state(capacity: HostedAnalysisCapacity): HostedAnalysisQueueState {
    const reservedForActive = Math.min(
      this.waiting.length,
      Math.max(0, capacity.activeLimit - this.running),
    );
    return {
      active: this.running + reservedForActive,
      queued: Math.max(0, this.waiting.length - reservedForActive),
      active_limit: capacity.activeLimit,
      queue_limit: capacity.queueLimit,
    };
  }

  private metadataFor(ticket: ScheduledTicket, capacity: HostedAnalysisCapacity): HostedAnalysisAdmissionMetadata {
    const index = this.waiting.indexOf(ticket);
    const queuePosition = index < 0 ? 0 : Math.max(0, this.running + index + 1 - capacity.activeLimit);
    return {
      ...this.state(capacity),
      queue_position: queuePosition,
      estimated_wait_ms: queuePosition === 0 ? 0 : Math.ceil(queuePosition / capacity.activeLimit) * this.estimatedDurationMs(),
    };
  }

  private estimatedDurationMs(): number {
    if (this.recentDurations.length === 0) {
      return positiveInteger(process.env.KLAURO_ANALYSIS_ESTIMATED_JOB_MS, DEFAULT_ESTIMATED_JOB_MS);
    }
    return Math.max(1000, Math.round(this.recentDurations.reduce((sum, value) => sum + value, 0) / this.recentDurations.length));
  }

  private notifyPositions(capacity = resolveHostedAnalysisCapacity()): void {
    for (const ticket of this.waiting) ticket.onPosition?.(this.metadataFor(ticket, capacity));
  }

  private cancel(ticket: ScheduledTicket): void {
    if (ticket.cancelled) return;
    ticket.cancelled = true;
    const index = this.waiting.indexOf(ticket);
    if (index !== -1) this.waiting.splice(index, 1);
    ticket.reject?.(new Error('Hosted analysis admission was cancelled.'));
    this.drain();
    this.notifyPositions();
  }

  private drain(): void {
    const capacity = resolveHostedAnalysisCapacity();
    while (this.running < capacity.activeLimit && this.waiting[0]?.task) {
      const ticket = this.waiting.shift()!;
      if (ticket.cancelled) continue;
      this.running += 1;
      ticket.onPosition?.({ ...this.state(capacity), queue_position: 0, estimated_wait_ms: 0 });
      const startedAt = Date.now();
      void Promise.resolve().then(ticket.task).then(ticket.resolve, ticket.reject).finally(() => {
        this.running = Math.max(0, this.running - 1);
        this.recentDurations.push(Date.now() - startedAt);
        if (this.recentDurations.length > 8) this.recentDurations.shift();
        this.drain();
        this.notifyPositions();
      });
    }
  }
}

const scheduler = new HostedAnalysisScheduler();

export function reserveHostedAnalysis(): HostedAnalysisAdmission {
  return scheduler.reserve();
}

export function reserveHostedAnalysisOrThrow(): HostedAnalysisTicket {
  const admission = reserveHostedAnalysis();
  if (!admission.admitted) throw new HostedAnalysisCapacityError(admission.overload);
  return admission.ticket;
}

export function executeHostedAnalysis<T>(
  ticket: HostedAnalysisTicket,
  task: () => Promise<T>,
  onPosition?: (metadata: HostedAnalysisAdmissionMetadata) => void,
): Promise<T> {
  return scheduler.execute(ticket, task, onPosition);
}

export function hostedAnalysisQueueState(): HostedAnalysisQueueState {
  return scheduler.snapshot();
}

export function __resetHostedAnalysisSchedulerForTests(): void {
  scheduler.reset();
}
