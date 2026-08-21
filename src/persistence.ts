import type { Pool } from 'pg';
import {
  PgJobStateRepository,
  type JobStateRepository,
} from './job-state.repository.js';
import {
  PgMessageRepository,
  type MessageRepository,
} from './messages.repository.js';

export interface CorePersistence {
  jobs: JobStateRepository;
  messages: MessageRepository;
}

export function createCorePersistence(pool: Pool): CorePersistence {
  return {
    jobs: new PgJobStateRepository(pool),
    messages: new PgMessageRepository(pool),
  };
}
