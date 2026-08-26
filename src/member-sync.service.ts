import { logger } from './logger.js';
import { projectClubMember } from './member-profile-text.js';
import type { MemberDirectoryService } from './member-directory.service.js';
import type { MemberSourceRecord } from './members.js';
import type { MemberRepository } from './members.repository.js';
import type { MemberSourceRepository } from './member-source.repository.js';

export interface MemberSyncResult {
  fetched: number;
  accepted: number;
  rejected: number;
  deactivated: number;
  indexed: number;
  failed: number;
}

export type StartupSyncResult = 'completed' | 'failed' | 'timed-out';

export class MemberSyncService {
  private running: Promise<MemberSyncResult> | null = null;

  constructor(private readonly deps: {
    source: MemberSourceRepository;
    members: MemberRepository;
    directory: Pick<MemberDirectoryService, 'indexPending'>;
    supportedPolicies: ReadonlySet<string>;
    now?: () => Date;
  }) {}

  sync(): Promise<MemberSyncResult> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async startupAttempt(timeoutMs: number): Promise<StartupSyncResult> {
    const observed = this.sync().then(
      () => 'completed' as const,
      () => 'failed' as const,
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timed-out'>((resolve) => {
      timeout = setTimeout(() => resolve('timed-out'), timeoutMs);
    });
    const result = await Promise.race([observed, timedOut]);
    if (timeout) clearTimeout(timeout);
    return result;
  }

  async hasSuccessfulSnapshot(): Promise<boolean> {
    return (await this.deps.members.readSourceStatus('web')) !== null;
  }

  private async runOnce(): Promise<MemberSyncResult> {
    const startedAtMs = Date.now();
    logger.info({ event: 'member-sync-started' }, 'Member source sync started');
    const rows = await this.deps.source.readSnapshot();
    const records: MemberSourceRecord[] = [];
    let rejected = 0;
    for (const row of rows) {
      const projected = projectClubMember(row, this.deps.supportedPolicies);
      if (projected.accepted) records.push(projected.record);
      else rejected += 1;
    }
    const completedAt = (this.deps.now ?? (() => new Date()))();
    const sourceStatus = await this.deps.members.replaceSourceSnapshot({
      source: 'web',
      records,
      fetchedCount: rows.length,
      rejectedCount: rejected,
      completedAt,
    });
    const index = await this.deps.directory.indexPending(1000);
    const result: MemberSyncResult = {
      fetched: rows.length,
      accepted: records.length,
      rejected,
      deactivated: sourceStatus.deactivatedCount,
      indexed: index.indexed,
      failed: index.failed,
    };
    logger.info(
      {
        event: 'member-sync-complete',
        ...result,
        durationMs: Date.now() - startedAtMs,
      },
      'Member source sync complete',
    );
    return result;
  }
}
