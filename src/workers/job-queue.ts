import { createHash } from 'crypto';
import { generateCorrelationId } from '../lib/observability/correlation';

export type JobStatus = 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'DEAD_LETTER';

export interface JobOptions {
  maxAttempts?: number;
  backoffMs?: number;
  idempotencyKey?: string;
  /** Reuse the caller's request correlation id; generated when omitted. */
  correlationId?: string;
}

export interface Job<T = any> {
  id: string;
  name: string;
  payload: T;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  backoffMs: number;
  idempotencyKey?: string;
  /** Stable across every attempt and retry so worker logs join the originating request. */
  correlationId: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type JobHandler<T = any> = (job: Job<T>) => Promise<void>;

export interface JobQueueOptions {
  /** Returns true when the actor may inspect or retry dead-letter jobs. Denies everything when omitted. */
  canOperate?: (actorId: string) => boolean;
}

export class JobQueueAuthorizationError extends Error {
  constructor(actorId: string) {
    super(`Actor "${actorId}" is not authorized to operate on dead-letter jobs`);
    this.name = 'JobQueueAuthorizationError';
  }
}

export class JobQueue {
  private jobs = new Map<string, Job>();
  private handlers = new Map<string, JobHandler>();
  private processedIdempotencyKeys = new Set<string>();

  constructor(private readonly options: JobQueueOptions = {}) {}

  public registerHandler(name: string, handler: JobHandler): void {
    this.handlers.set(name, handler);
  }

  public enqueue<T>(name: string, payload: T, options?: JobOptions): Job<T> {
    const idempotencyKey = options?.idempotencyKey ||
      createHash('sha256').update(name + JSON.stringify(payload)).digest('hex');

    for (const j of this.jobs.values()) {
      if (j.idempotencyKey === idempotencyKey && j.status !== 'FAILED' && j.status !== 'DEAD_LETTER') {
        return j as Job<T>;
      }
    }

    const id = `job_${Math.random().toString(36).substring(2, 9)}_${Date.now()}`;
    const job: Job<T> = {
      id,
      name,
      payload,
      status: 'PENDING',
      attempts: 0,
      maxAttempts: options?.maxAttempts ?? 3,
      backoffMs: options?.backoffMs ?? 1000,
      idempotencyKey,
      correlationId: options?.correlationId || generateCorrelationId(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.jobs.set(id, job);
    return job;
  }

  public async processJob(id: string): Promise<Job> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job "${id}" not found`);
    }

    if (job.status === 'COMPLETED' || job.status === 'DEAD_LETTER') {
      return job;
    }

    const handler = this.handlers.get(job.name);
    if (!handler) {
      job.status = 'FAILED';
      job.lastError = `No handler registered for job type "${job.name}"`;
      job.updatedAt = new Date().toISOString();
      return job;
    }

    job.status = 'PROCESSING';
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();

    try {
      await handler(job);
      job.status = 'COMPLETED';
      job.updatedAt = new Date().toISOString();
      if (job.idempotencyKey) {
        this.processedIdempotencyKeys.add(job.idempotencyKey);
      }
    } catch (err: any) {
      job.lastError = err?.message || String(err);
      job.updatedAt = new Date().toISOString();

      if (job.attempts >= job.maxAttempts) {
        job.status = 'DEAD_LETTER';
      } else {
        job.status = 'FAILED';
      }
    }

    return job;
  }

  /** Operator view of jobs that exhausted their attempts. Requires `canOperate`. */
  public listDeadLetterJobs(actorId: string): Job[] {
    this.assertOperator(actorId);
    return this.getAllJobs().filter((j) => j.status === 'DEAD_LETTER');
  }

  /**
   * Re-queues a dead-letter job for a fresh attempt cycle. Attempts reset to zero so the job
   * gets its full `maxAttempts` again; `lastError` is kept so operators can see why it failed.
   * The correlation id is unchanged, so the retry stays linked to the original request.
   */
  public retryDeadLetterJob(id: string, actorId: string): Job {
    this.assertOperator(actorId);

    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job "${id}" not found`);
    }
    if (job.status !== 'DEAD_LETTER') {
      throw new Error(`Job "${id}" is ${job.status}, not DEAD_LETTER`);
    }

    job.status = 'PENDING';
    job.attempts = 0;
    job.updatedAt = new Date().toISOString();
    return job;
  }

  public getJob(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  public getAllJobs(): Job[] {
    return Array.from(this.jobs.values());
  }

  private assertOperator(actorId: string): void {
    if (!this.options.canOperate?.(actorId)) {
      throw new JobQueueAuthorizationError(actorId);
    }
  }
}
