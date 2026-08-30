import { afterEach, expect, it, vi } from 'vitest';
import type { Bot, CommandContext, Context } from 'grammy';
import { logger } from './logger.js';
import type { PublicMemberMatch, MemberMatcher } from './request.matcher.js';
import {
  registerPrivateRequestCommand,
  type PrivateRequestCommandOptions,
} from './private-request-command.js';

type PrivateContext = CommandContext<Context>;
type CommandHandler = (ctx: PrivateContext) => Promise<void>;

const oneMatch: PublicMemberMatch[] = [{
  memberId: 'anna',
  displayName: 'Анна',
  telegramUsername: 'anna_product',
  evidence: 'Запускала B2B SaaS',
  similarity: 1,
}];

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeBot() {
  let handler: CommandHandler | undefined;
  const command = vi.fn((_name: string, next: CommandHandler) => {
    handler = next;
  });
  return {
    bot: { command } as unknown as Bot,
    command,
    getHandler: () => handler,
  };
}

function matcherReturning(matches: readonly PublicMemberMatch[] = oneMatch) {
  return {
    match: vi.fn().mockResolvedValue(matches),
  } as unknown as Pick<MemberMatcher, 'match'>;
}

function commandOptions(
  overrides: Partial<PrivateRequestCommandOptions> = {},
): PrivateRequestCommandOptions {
  return {
    adminUserId: 101,
    matcher: matcherReturning(),
    isMatchingReady: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function commandContext(overrides: Partial<{
  fromId: number;
  chatType: 'private' | 'supergroup';
  match: string;
  editFailure: Error;
}> = {}) {
  const fromId = overrides.fromId ?? 101;
  const chatType = overrides.chatType ?? 'private';
  const reply = vi.fn().mockResolvedValue({
    chat: { id: fromId, type: chatType },
    message_id: 88,
  });
  const editMessageText = overrides.editFailure
    ? vi.fn().mockRejectedValue(overrides.editFailure)
    : vi.fn().mockResolvedValue({ message_id: 88 });
  const ctx = {
    chat: { id: fromId, type: chatType },
    from: { id: fromId },
    match: overrides.match ?? 'Ищу B2B SaaS',
    reply,
    api: { editMessageText },
  } as unknown as PrivateContext;
  return { ctx, reply, editMessageText };
}

function registeredCommand(
  overrides: Partial<PrivateRequestCommandOptions> = {},
) {
  const fake = fakeBot();
  const options = commandOptions(overrides);
  registerPrivateRequestCommand(fake.bot, options);
  const handler = fake.getHandler();
  if (!handler) throw new Error('private request command was not registered');
  return { handler, options, command: fake.command };
}

it('does not register when the owner ID is absent', () => {
  const fake = fakeBot();

  registerPrivateRequestCommand(fake.bot, commandOptions({ adminUserId: null }));

  expect(fake.command).not.toHaveBeenCalled();
});

it('silently ignores another user and non-private chats', async () => {
  const matcher = matcherReturning();
  const { handler } = registeredCommand({ matcher });
  const anotherUser = commandContext({ fromId: 202 });
  const group = commandContext({ chatType: 'supergroup' });

  await handler(anotherUser.ctx);
  await handler(group.ctx);

  expect(anotherUser.reply).not.toHaveBeenCalled();
  expect(group.reply).not.toHaveBeenCalled();
  expect(matcher.match).not.toHaveBeenCalled();
});

it('returns usage for an empty owner command without running matching', async () => {
  const matcher = matcherReturning();
  const { handler } = registeredCommand({ matcher });
  const request = commandContext({ match: '   ' });

  await handler(request.ctx);

  expect(request.reply).toHaveBeenCalledWith(
    'Использование: /test_request <текст запроса>',
  );
  expect(matcher.match).not.toHaveBeenCalled();
});

it('allows one grounded self-match without excluding the owner', async () => {
  const matcher = matcherReturning(oneMatch);
  const { handler } = registeredCommand({ matcher });
  const request = commandContext();

  await handler(request.ctx);

  expect(request.reply).toHaveBeenCalledWith('⏳ Ищу подходящих участников…');
  expect(request.reply.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(matcher.match).mock.invocationCallOrder[0]!,
  );
  expect(matcher.match).toHaveBeenCalledWith('Ищу B2B SaaS', {
    minimumMatches: 1,
  });
  expect(request.editMessageText).toHaveBeenCalledWith(
    101,
    88,
    expect.stringContaining('@anna_product'),
    { parse_mode: 'HTML' },
  );
});

it('edits the status message without mentions when nothing is grounded', async () => {
  const matcher = matcherReturning([]);
  const { handler } = registeredCommand({ matcher });
  const request = commandContext();

  await handler(request.ctx);

  expect(request.editMessageText).toHaveBeenCalledWith(
    101,
    88,
    'Надёжных совпадений не найдено.',
    { parse_mode: 'HTML' },
  );
});

it('fails safely before matching when the member source is not ready', async () => {
  const matcher = matcherReturning();
  const { handler } = registeredCommand({
    matcher,
    isMatchingReady: vi.fn().mockResolvedValue(false),
  });
  const request = commandContext();

  await handler(request.ctx);

  expect(matcher.match).not.toHaveBeenCalled();
  expect(request.editMessageText).toHaveBeenCalledWith(
    101,
    88,
    'Подбор участников временно недоступен. Попробуйте позже.',
  );
});

it('logs only safe metadata when matching and fallback editing fail', async () => {
  const error = vi.spyOn(logger, 'error');
  const matcher = {
    match: vi.fn().mockRejectedValue(new Error('provider included private query')),
  } as unknown as Pick<MemberMatcher, 'match'>;
  const { handler } = registeredCommand({ matcher });
  const request = commandContext({
    match: 'sensitive owner query',
    editFailure: new Error('telegram included private payload'),
  });

  await handler(request.ctx);

  expect(error).toHaveBeenCalledTimes(2);
  const logged = JSON.stringify(error.mock.calls.map((call) => call[0]));
  expect(logged).not.toContain('sensitive owner query');
  expect(logged).not.toContain('provider included private query');
  expect(logged).not.toContain('telegram included private payload');
  expect(logged).toContain('test_request');
});
