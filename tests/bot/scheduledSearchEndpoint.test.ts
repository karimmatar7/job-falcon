import { describe, expect, it, vi } from "vitest";
import {
  createScheduledSearchEndpoint,
  type CronRequest,
  type CronResponse,
  type DueScheduler,
} from "../../src/bot/scheduledSearchEndpoint.js";
import { Scheduler } from "../../src/services/scheduling/scheduler.js";
import type { JobSearchFn } from "../../src/services/scheduling/searchRunner.js";
import { Notifier } from "../../src/services/scheduling/notifications.js";
import type { NotificationSender } from "../../src/services/scheduling/notifications.js";
import {
  InMemoryStateStore,
  createInitialState,
} from "../../src/services/state/stateStore.js";
import type { DueRunOutcome } from "../../src/services/scheduling/scheduler.js";
import {
  FakeTimers,
  makeJobSearchResult,
  silentLogger,
} from "../testKit.js";

const SECRET = "a-very-secret-cron-value";

interface FakeResponse extends CronResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function makeRes(): FakeResponse {
  return {
    statusCode: 0,
    body: undefined,
    headers: {},
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
}

function makeReq(authorization?: string): CronRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
  };
}

function makeFakeScheduler(outcome: DueRunOutcome | Error) {
  const runIfDue = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { runIfDue } as DueScheduler & { runIfDue: typeof runIfDue };
}

describe("scheduled search endpoint", () => {
  it("rejects a request with no Authorization header", async () => {
    const scheduler = makeFakeScheduler({ ran: false, reason: "not-due" });
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      makeReq(),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(scheduler.runIfDue).not.toHaveBeenCalled();
  });

  it("rejects a wrong secret", async () => {
    const scheduler = makeFakeScheduler({ ran: false, reason: "not-due" });
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      makeReq("Bearer wrong-secret"),
      res,
    );

    expect(res.statusCode).toBe(401);
    expect(scheduler.runIfDue).not.toHaveBeenCalled();
  });

  it("fails closed when no secret is configured", async () => {
    const scheduler = makeFakeScheduler({ ran: false, reason: "not-due" });
    const res = makeRes();
    await createScheduledSearchEndpoint({
      scheduler,
      logger: silentLogger,
      secret: undefined,
    })(makeReq(`Bearer ${SECRET}`), res);

    expect(res.statusCode).toBe(401);
    expect(scheduler.runIfDue).not.toHaveBeenCalled();
  });

  it("runs the scheduler and reports the record when authorized", async () => {
    const outcome: DueRunOutcome = {
      ran: true,
      reason: "ran",
      record: {
        startedAt: "2026-06-01T07:00:00.000Z",
        finishedAt: "2026-06-01T07:00:05.000Z",
        trigger: "schedule",
        status: "success",
        discovered: 0,
        notified: 0,
        failed: 0,
        summarised: 0,
      },
    };
    const scheduler = makeFakeScheduler(outcome);
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      makeReq(`Bearer ${SECRET}`),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(scheduler.runIfDue).toHaveBeenCalledWith("schedule");
    expect(res.body).toMatchObject({ ok: true, ran: true, reason: "ran" });
  });

  it("reports a non-due trigger without running", async () => {
    const scheduler = makeFakeScheduler({ ran: false, reason: "not-due" });
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      makeReq(`Bearer ${SECRET}`),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ran: false, reason: "not-due" });
  });

  it("returns 500 (without leaking the secret) when the scheduler throws", async () => {
    const scheduler = makeFakeScheduler(new Error(`boom ${SECRET}`));
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      makeReq(`Bearer ${SECRET}`),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    expect(res.body).toMatchObject({ ok: false });
  });

  it("accepts the header regardless of casing", async () => {
    const scheduler = makeFakeScheduler({ ran: false, reason: "not-due" });
    const res = makeRes();
    await createScheduledSearchEndpoint({ scheduler, logger: silentLogger, secret: SECRET })(
      { headers: { Authorization: `Bearer ${SECRET}` } },
      res,
    );

    expect(res.statusCode).toBe(200);
  });
});

describe("scheduled search endpoint (integrated with the real scheduler)", () => {
  function makeRealScheduler() {
    const store = new InMemoryStateStore(createInitialState());
    const now = () => new Date("2026-06-01T09:00:00.000Z");
    const search = vi.fn(async () => makeJobSearchResult([]));
    const sender = vi.fn(async () => 1);
    const notifier = new Notifier({
      store,
      sender: sender as unknown as NotificationSender,
      logger: silentLogger,
      now,
    });
    const scheduler = new Scheduler({
      store,
      search: search as unknown as JobSearchFn,
      notifier,
      logger: silentLogger,
      chatId: 42,
      now,
      timers: new FakeTimers(),
    });
    return { scheduler, store, search, sender };
  }

  it("is idempotent: repeated protected triggers run the search once", async () => {
    const { scheduler, store, search } = makeRealScheduler();
    await store.update((draft) => {
      draft.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    });
    const endpoint = createScheduledSearchEndpoint({
      scheduler,
      logger: silentLogger,
      secret: SECRET,
    });

    const first = makeRes();
    await endpoint(makeReq(`Bearer ${SECRET}`), first);
    const second = makeRes();
    await endpoint(makeReq(`Bearer ${SECRET}`), second);

    expect(first.body).toMatchObject({ ran: true });
    expect(second.body).toMatchObject({ ran: false, reason: "not-due" });
    expect(search).toHaveBeenCalledTimes(1);
  });

  it("reports a failed run truthfully and keeps the endpoint healthy", async () => {
    const { scheduler, store, search } = makeRealScheduler();
    search.mockRejectedValueOnce(new Error("network down"));
    await store.update((draft) => {
      draft.schedule.nextRunAt = "2026-05-31T07:00:00.000Z";
    });
    const endpoint = createScheduledSearchEndpoint({
      scheduler,
      logger: silentLogger,
      secret: SECRET,
    });

    const res = makeRes();
    await endpoint(makeReq(`Bearer ${SECRET}`), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, ran: true });
    expect((res.body as { record: { status: string } }).record.status).toBe("failed");
  });
});
