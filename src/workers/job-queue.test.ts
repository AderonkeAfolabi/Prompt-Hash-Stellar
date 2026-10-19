import { JobQueue, JobQueueAuthorizationError } from './job-queue';
import { handlePromptVerification, PromptVerificationPayload } from './tasks/prompt-verification';

describe('JobQueue & Background Workers (#805)', () => {
  let queue: JobQueue;

  beforeEach(() => {
    queue = new JobQueue();
    queue.registerHandler('verify-prompt', handlePromptVerification);
  });

  it('successfully enqueues and processes a job', async () => {
    const payload: PromptVerificationPayload = {
      promptId: 'prompt-999',
      creatorAddress: 'GBX...CREATOR',
      stellarTxHash: 'tx-hash-abc',
    };

    const job = queue.enqueue('verify-prompt', payload);
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);

    const processed = await queue.processJob(job.id);
    expect(processed.status).toBe('COMPLETED');
    expect(processed.attempts).toBe(1);
  });

  it('retries failed jobs and eventually succeeds on retry', async () => {
    const payload: PromptVerificationPayload = {
      promptId: 'prompt-fail',
      creatorAddress: 'GBX...CREATOR',
      stellarTxHash: 'simulate-retry',
    };

    const job = queue.enqueue('verify-prompt', payload, { maxAttempts: 2 });
    
    let res = await queue.processJob(job.id);
    expect(res.status).toBe('FAILED');
    expect(res.attempts).toBe(1);

    res = await queue.processJob(job.id);
    expect(res.status).toBe('COMPLETED');
    expect(res.attempts).toBe(2);
  });

  it('moves job to DEAD_LETTER when maxAttempts is exceeded', async () => {
    queue.registerHandler('always-fail', async () => {
      throw new Error('Permanent failure');
    });

    const job = queue.enqueue('always-fail', { test: true }, { maxAttempts: 2 });

    await queue.processJob(job.id);
    const res = await queue.processJob(job.id);
    expect(res.status).toBe('DEAD_LETTER');
    expect(res.attempts).toBe(2);
  });

  it('ensures idempotency by preventing duplicate pending jobs', () => {
    const payload = { promptId: 'p-1', creatorAddress: 'G1', stellarTxHash: 'tx-1' };
    const job1 = queue.enqueue('verify-prompt', payload, { idempotencyKey: 'idem-key-1' });
    const job2 = queue.enqueue('verify-prompt', payload, { idempotencyKey: 'idem-key-1' });

    expect(job1.id).toBe(job2.id);
    expect(queue.getAllJobs().length).toBe(1);
  });

  describe('request correlation (#1016)', () => {
    it('keeps the caller correlation id on every attempt', async () => {
      const seen: string[] = [];
      queue.registerHandler('trace', async (job) => {
        seen.push(job.correlationId);
        throw new Error('transient');
      });

      const job = queue.enqueue('trace', { n: 1 }, { maxAttempts: 2, correlationId: 'req-abc' });
      await queue.processJob(job.id);
      await queue.processJob(job.id);

      expect(seen).toEqual(['req-abc', 'req-abc']);
    });

    it('generates a correlation id when the caller supplies none', () => {
      const a = queue.enqueue('verify-prompt', { n: 'a' });
      const b = queue.enqueue('verify-prompt', { n: 'b' });

      expect(a.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(b.correlationId).not.toBe(a.correlationId);
    });
  });

  describe('dead-letter operator tooling (#1015)', () => {
    const operators = new Set(['ops-1']);
    let ops: JobQueue;

    beforeEach(() => {
      ops = new JobQueue({ canOperate: (actor) => operators.has(actor) });
      ops.registerHandler('always-fail', async () => {
        throw new Error('boom');
      });
    });

    const deadLetter = async (q: JobQueue, payload: object) => {
      const job = q.enqueue('always-fail', payload, { maxAttempts: 1, correlationId: 'req-dl' });
      await q.processJob(job.id);
      return job;
    };

    it('lists only dead-letter jobs for an operator', async () => {
      await deadLetter(ops, { n: 1 });
      ops.enqueue('always-fail', { n: 2 });

      const listed = ops.listDeadLetterJobs('ops-1');
      expect(listed.map((j) => j.status)).toEqual(['DEAD_LETTER']);
      expect(listed[0].lastError).toBe('boom');
    });

    it('retries a dead-letter job with a fresh attempt budget and the same correlation id', async () => {
      const job = await deadLetter(ops, { n: 3 });

      const retried = ops.retryDeadLetterJob(job.id, 'ops-1');
      expect(retried.status).toBe('PENDING');
      expect(retried.attempts).toBe(0);
      expect(retried.correlationId).toBe('req-dl');
      expect(retried.lastError).toBe('boom');
    });

    it('rejects retry for a job that is not in dead-letter', () => {
      const job = ops.enqueue('always-fail', { n: 4 });
      expect(() => ops.retryDeadLetterJob(job.id, 'ops-1')).toThrow(/not DEAD_LETTER/);
    });

    it('rejects retry for an unknown job id', () => {
      expect(() => ops.retryDeadLetterJob('missing', 'ops-1')).toThrow(/not found/);
    });

    it('denies list and retry to an actor without operator rights', async () => {
      const job = await deadLetter(ops, { n: 5 });

      expect(() => ops.listDeadLetterJobs('viewer-9')).toThrow(JobQueueAuthorizationError);
      expect(() => ops.retryDeadLetterJob(job.id, 'viewer-9')).toThrow(JobQueueAuthorizationError);
      expect(ops.getJob(job.id)?.status).toBe('DEAD_LETTER');
    });

    it('denies every actor when no canOperate policy is configured', async () => {
      const locked = new JobQueue();
      locked.registerHandler('always-fail', async () => {
        throw new Error('boom');
      });
      const job = await deadLetter(locked, { n: 6 });

      expect(() => locked.listDeadLetterJobs('ops-1')).toThrow(JobQueueAuthorizationError);
      expect(() => locked.retryDeadLetterJob(job.id, 'ops-1')).toThrow(JobQueueAuthorizationError);
    });

    it('retried job can succeed on the next run without being re-dead-lettered', async () => {
      let shouldFail = true;
      ops.registerHandler('flaky', async () => {
        if (shouldFail) throw new Error('down');
      });
      const job = ops.enqueue('flaky', { n: 7 }, { maxAttempts: 1 });
      await ops.processJob(job.id);
      expect(ops.getJob(job.id)?.status).toBe('DEAD_LETTER');

      shouldFail = false;
      ops.retryDeadLetterJob(job.id, 'ops-1');
      const res = await ops.processJob(job.id);
      expect(res.status).toBe('COMPLETED');
      expect(res.attempts).toBe(1);
    });
  });
});
