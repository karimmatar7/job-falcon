import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import * as http from "node:http";
import { Bot } from "grammy";
import { createWebhookHandler } from "../../src/bot/webhook.js";
import type { AppConfig } from "../../src/config/env.js";
import type { Logger } from "../../src/utils/logger.js";

const BOT_INFO = {
  id: 123456789,
  is_bot: true as const,
  first_name: "Job Scout",
  username: "job_scout_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const silentLogger: Logger = { info() {}, warn() {}, error() {} };

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    telegramBotToken: "123456789:AAWebhookToken",
    allowedUserId: 987654321,
    webhookSecret: "test-secret_123",
    ...overrides,
  };
}

interface FakeReq extends Readable {
  headers: Record<string, string | string[] | undefined>;
}

function makeReq(
  body: string,
  headers: Record<string, string | string[] | undefined>,
): FakeReq {
  const req = Readable.from([Buffer.from(body)]) as FakeReq;
  req.headers = headers;
  return req;
}

function makeRes() {
  const res = {
    statusCode: undefined as number | undefined,
    body: undefined as string | undefined,
    ended: false,
    writeHead(code: number) {
      res.statusCode = code;
      return res;
    },
    end(json?: string) {
      res.ended = true;
      res.body = json;
    },
  };
  return res;
}

describe("createWebhookHandler", () => {
  it("refuses to build a handler without a secret token", () => {
    const config = makeConfig();
    const bot = new Bot(config.telegramBotToken, { botInfo: BOT_INFO });
    const { webhookSecret: _omitted, ...withoutSecret } = config;
    expect(() =>
      createWebhookHandler(withoutSecret, silentLogger, bot),
    ).toThrow(/TELEGRAM_WEBHOOK_SECRET/);
  });

  it("disables long polling on the webhook bot instance", () => {
    const config = makeConfig();
    const bot = new Bot(config.telegramBotToken, { botInfo: BOT_INFO });
    createWebhookHandler(config, silentLogger, bot);
    expect(() => bot.start()).toThrow(/long polling/);
  });

  it("rejects requests with a wrong secret token", async () => {
    const config = makeConfig();
    const bot = new Bot(config.telegramBotToken, { botInfo: BOT_INFO });
    const handler = createWebhookHandler(config, silentLogger, bot);
    const req = makeReq("", {
      "x-telegram-bot-api-secret-token": "wrong-secret",
    });
    const res = makeRes();

    await handler(
      req as unknown as Parameters<typeof handler>[0],
      res as unknown as Parameters<typeof handler>[1],
    );

    expect(res.statusCode).toBe(401);
    expect(res.ended).toBe(true);
  });

  it("accepts an update with the correct secret token", async () => {
    const config = makeConfig();
    const bot = new Bot(config.telegramBotToken, { botInfo: BOT_INFO });
    const handler = createWebhookHandler(config, silentLogger, bot);
    const update = {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: { id: config.allowedUserId, type: "private" },
        from: { id: config.allowedUserId, is_bot: false, first_name: "Owner" },
        text: "hello",
      },
    };
    const req = makeReq(JSON.stringify(update), {
      "x-telegram-bot-api-secret-token": config.webhookSecret,
    });
    const res = makeRes();

    await handler(
      req as unknown as Parameters<typeof handler>[0],
      res as unknown as Parameters<typeof handler>[1],
    );

    expect(res.statusCode).toBeUndefined();
    expect(res.ended).toBe(true);
  });

  it("serves updates over a real HTTP route (POST /api/webhook)", async () => {
    const config = makeConfig();
    const bot = new Bot(config.telegramBotToken, { botInfo: BOT_INFO });
    const handler = createWebhookHandler(config, silentLogger, bot);

    const server = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("Expected a TCP port from the test server.");
    }
    const baseUrl = `http://127.0.0.1:${address.port}/api/webhook`;

    try {
      const missingSecret = await fetch(baseUrl, { method: "POST", body: "{}" });
      expect(missingSecret.status).toBe(401);

      const update = {
        update_id: 99,
        message: {
          message_id: 9,
          date: 1_700_000_000,
          chat: { id: config.allowedUserId, type: "private" },
          from: { id: config.allowedUserId, is_bot: false, first_name: "Owner" },
          text: "hello",
        },
      };
      const withSecret = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": config.webhookSecret,
        },
        body: JSON.stringify(update),
      });
      expect(withSecret.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
