import "dotenv/config";
import { loadConfig } from "../config/env.js";
import { buildWebhookUrl, resolveWebhookBaseUrl } from "../config/webhook.js";

const API_ROOT = "https://api.telegram.org";

/**
 * Call a Telegram Bot API method and return its `result`, throwing a
 * value-free error (never the token) when the call fails.
 */
async function callTelegram(
  token: string,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${API_ROOT}/bot${token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    data = undefined;
  }

  const ok =
    response.ok &&
    data !== null &&
    typeof data === "object" &&
    (data as { ok?: boolean }).ok === true;

  if (!ok) {
    throw new Error(
      `Telegram ${method} failed (HTTP ${response.status}). Check BOT_TOKEN, the webhook URL and the secret token.`,
    );
  }

  return (data as { result?: unknown }).result;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const command = (process.argv[2] ?? "set").toLowerCase();

  if (command === "delete") {
    await callTelegram(config.telegramBotToken, "deleteWebhook", {
      drop_pending_updates: false,
    });
    console.log(
      "Webhook deleted. You can now run `npm run dev` to use long polling.",
    );
    return;
  }

  if (!config.webhookSecret) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be set before registering the webhook.",
    );
  }

  const baseUrl = config.webhookUrl ?? resolveWebhookBaseUrl();
  if (baseUrl.length === 0) {
    throw new Error(
      "Set TELEGRAM_WEBHOOK_URL (or deploy to Vercel so VERCEL_URL is available) before registering the webhook.",
    );
  }
  const webhookUrl = buildWebhookUrl(baseUrl);

  await callTelegram(config.telegramBotToken, "setWebhook", {
    url: webhookUrl,
    secret_token: config.webhookSecret,
    allowed_updates: ["message", "callback_query"],
  });
  console.log(`Webhook registered at ${webhookUrl}`);

  const info = await callTelegram(config.telegramBotToken, "getWebhookInfo", {});
  console.log(`Webhook info: ${JSON.stringify(info)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
