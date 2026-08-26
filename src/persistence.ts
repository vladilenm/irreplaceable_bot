import type { Pool } from 'pg';
import {
  PgJobStateRepository,
  type JobStateRepository,
} from './job-state.repository.js';
import {
  PgMessageRepository,
  type MessageRepository,
} from './messages.repository.js';
import {
  PgMemberRepository,
  type MemberRepository,
} from './members.repository.js';
import {
  PgMemberSourceRepository,
  type MemberSourceRepository,
} from './member-source.repository.js';
import {
  PgRequestRepository,
  type RequestRepository,
} from './request.repository.js';
import {
  PgScheduledPublicationRepository,
  type ScheduledPublicationRepository,
} from './scheduled-publication.repository.js';

export interface CorePersistence {
  jobs: JobStateRepository;
  messages: MessageRepository;
  publications: ScheduledPublicationRepository;
}

export interface Persistence extends CorePersistence {
  members: MemberRepository;
  memberSource: MemberSourceRepository;
  requests: RequestRepository;
}

export function createPersistence(pool: Pool): Persistence {
  return {
    jobs: new PgJobStateRepository(pool),
    messages: new PgMessageRepository(pool),
    publications: new PgScheduledPublicationRepository(pool),
    members: new PgMemberRepository(pool),
    memberSource: new PgMemberSourceRepository(pool),
    requests: new PgRequestRepository(pool),
  };
}

export const createCorePersistence = createPersistence;
