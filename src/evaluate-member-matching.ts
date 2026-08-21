import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { config } from './config.js';
import { closeDb, initDb } from './database.js';
import { createRequestMatchingRuntime } from './request.runtime.js';

const EvalSchema = z.array(z.object({
  query: z.string().min(1),
  expectedUsernames: z.array(z.string().min(1)).min(1),
})).min(20).max(30);

export type EvaluationCase = z.infer<typeof EvalSchema>[number];

export function parseEvaluationCases(raw: unknown): EvaluationCase[] {
  return EvalSchema.parse(raw);
}

export function caseSucceeded(
  matches: readonly { telegramUsername: string }[],
  expectedUsernames: readonly string[],
): boolean {
  const expected = new Set(expectedUsernames.map((username) => username.toLowerCase()));
  return matches
    .slice(0, 5)
    .some((match) => expected.has(match.telegramUsername.toLowerCase()));
}

function evaluationPath(): string {
  const path = process.argv[2];
  if (!path) throw new Error('Pass a private evaluation JSON file path');
  return path;
}

export async function runMemberMatchingEvaluation(path = evaluationPath()): Promise<number> {
  const cases = parseEvaluationCases(JSON.parse(readFileSync(path, 'utf8')));
  if (!config.requestMatching) {
    throw new Error('REQUEST_MATCHING_ENABLED must be true for evaluation');
  }

  initDb();
  try {
    const runtime = createRequestMatchingRuntime(config.requestMatching);
    await runtime.syncService.sync();
    let succeeded = 0;

    for (const [index, evaluationCase] of cases.entries()) {
      const matches = await runtime.matcher.match(evaluationCase.query);
      const success = caseSucceeded(matches, evaluationCase.expectedUsernames);
      if (success) succeeded++;
      console.info(`case=${String(index + 1)} success=${String(success)} results=${String(matches.length)}`);
    }

    const percentage = (succeeded / cases.length) * 100;
    console.info(`success_rate=${percentage.toFixed(1)}%`);
    return percentage >= 80 ? 0 : 1;
  } finally {
    closeDb();
  }
}

const currentFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile === currentFile) {
  void runMemberMatchingEvaluation()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch(() => {
      console.error('Member matching evaluation failed');
      process.exitCode = 1;
    });
}
