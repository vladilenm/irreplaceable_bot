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
  PgRequestRepository,
  type RequestRepository,
} from './request.repository.js';

export interface CorePersistence {
  jobs: JobStateRepository;
  messages: MessageRepository;
}

export interface Persistence extends CorePersistence {
  members: MemberRepository;
  requests: RequestRepository;
}

export function createPersistence(pool: Pool): Persistence {
  return {
    jobs: new PgJobStateRepository(pool),
    messages: new PgMessageRepository(pool),
    members: new PgMemberRepository(pool),
    requests: new PgRequestRepository(pool),
  };
}

export const createCorePersistence = createPersistence;
