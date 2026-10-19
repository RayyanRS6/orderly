// Fix package 7 in the local store (demo and tests), which mirrors the SQL in
// prelaunch-fx7-sql.test.ts: a customer who keeps writing becomes overdue (sql-3) and a message
// held in order is not "stalled" (sql-4).
import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MemoryRepository } from '../server/repository';
import { makeJob } from '../server/jobs';
import { createConversation } from '../src/domain/engine';
import { seedCompanies } from '../src/shared/seed';
import type { Conversation, Job, Message, TurnExplanation } from '../src/shared/types';

const company = seedCompanies[0]!;
const now = () => new Date().toISOString();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60000).toISOString();
let repo: MemoryRepository;
beforeEach(async () => {
  repo = new MemoryRepository(false);
  await repo.saveCompany({ ...company, botEnabled: false });
});

describe('sql-3: a customer who keeps writing becomes overdue, in memory', () => {
  const message = (
    role: Message['role'],
    text: string,
    createdAt: string,
    extra: Partial<Message> = {},
  ): Message => ({ id: randomUUID(), role, text, createdAt, ...extra });
  let phones = 0;
  async function waiting(messages: Message[], extra: Partial<Conversation> = {}) {
    const updatedAt = messages.at(-1)?.createdAt ?? now();
    const c: Conversation = {
      ...createConversation(
        company.id,
        `+9230078${String(++phones).padStart(5, '0')}`,
        'whatsapp',
        updatedAt,
      ),
      mode: 'human',
      messages,
      updatedAt,
      ...extra,
      version: 1,
    };
    expect(await repo.saveConversation(c, 0)).toBe(true);
    return c;
  }
  const since = async (c: Conversation) => {
    const item = (await repo.staffAttention(company.id)).items.find(
      (a) => a.id === `handoff:${c.id}`,
    );
    return item && Date.parse(item.createdAt);
  };

  it('counts from the first of several messages, so asking again every 8 minutes is overdue', async () => {
    const c = await waiting(
      [40, 32, 24, 16, 8].map((m) => message('customer', 'hello?', minutesAgo(m))),
    );
    expect(await since(c)).toBe(Date.parse(c.messages[0]!.createdAt));
    expect(await repo.hasOverdueAttention(company.id, 10)).toBe(true);
    expect(await repo.hasOverdueAttention(company.id, 45)).toBe(false);
  });

  it('counts from the message the bot handed over, not from those it answered before', async () => {
    const asked = minutesAgo(30);
    const answered = [
      message('customer', 'menu', minutesAgo(60)),
      message('assistant', 'Here is our menu.', minutesAgo(60)),
      message('customer', 'I want to speak to someone', asked),
    ];
    const plain = await waiting([
      ...answered,
      message('assistant', 'A staff member will reply here shortly.', asked),
    ]);
    expect(await since(plain)).toBe(Date.parse(asked));
    const nudged = await waiting([
      ...answered,
      message('assistant', 'A staff member will reply here shortly.', asked, {
        explanation: { outcome: 'staff' } as TurnExplanation,
      }),
      message('customer', 'hello?', minutesAgo(20)),
      message('customer', 'hello??', minutesAgo(10)),
    ]);
    expect(await since(nudged)).toBe(Date.parse(asked));
  });

  it('counts from the first message after the bot’s last answer, after a staff reply and after a takeover', async () => {
    const paused = await waiting([
      message('customer', 'menu', minutesAgo(60)),
      message('assistant', 'Here is our menu.', minutesAgo(60)),
      message('customer', 'one biryani', minutesAgo(20)),
      message('customer', 'hello?', minutesAgo(5)),
    ]);
    expect(await since(paused)).toBe(Date.parse(paused.messages[2]!.createdAt));
    const replied = await waiting([
      message('customer', 'Is it ready?', minutesAgo(60)),
      message('staff', 'Five minutes.', minutesAgo(50)),
      message('staff', 'Order ORD-1 is now ready.', minutesAgo(45), { notice: true }),
      message('customer', 'Still waiting', minutesAgo(30)),
      message('customer', 'Hello?', minutesAgo(10)),
    ]);
    expect(await since(replied)).toBe(Date.parse(replied.messages[3]!.createdAt));
    const takenOver = await waiting(
      [
        message('customer', 'menu', minutesAgo(60)),
        message('assistant', 'Here is our menu.', minutesAgo(60)),
        message('customer', 'hello?', minutesAgo(20)),
        message('customer', 'hello??', minutesAgo(10)),
      ],
      { humanSince: minutesAgo(25) },
    );
    expect(await since(takenOver)).toBe(Date.parse(takenOver.messages[2]!.createdAt));
  });
});

describe('sql-4: a message held in order behind an earlier one is not stalled, in memory', () => {
  const job = (id: string, changes: Partial<Job> = {}): Job => ({
    ...makeJob(company.id, 'incoming', { phone: '', streamKey: 's-1' }, id),
    nextRunAt: minutesAgo(5),
    ...changes,
  });

  it('is ok while the earlier message waits to be retried, and counts only the first', async () => {
    await repo.insertJob(job('retrying', { attempts: 3, nextRunAt: minutesAgo(-1) }));
    await repo.insertJob(job('held'));
    expect(await repo.pipelineHealth()).toMatchObject({ status: 'ok', stalledJobs: 0 });
    await repo.saveJob({ ...(await repo.getJob('retrying'))!, nextRunAt: minutesAgo(6) });
    expect(await repo.pipelineHealth()).toMatchObject({ status: 'stalled', stalledJobs: 1 });
  });
});
