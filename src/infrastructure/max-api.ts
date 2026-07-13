import { z } from "zod";

export const MAX_API_BASE_URL = "https://platform-api2.max.ru";

const actionSchema = z.object({ success: z.boolean(), message: z.string().optional() });
const commandsSchema = z.object({
  commands: z.array(z.object({ name: z.string(), description: z.string().nullable().optional() })),
});
const botInfoSchema = z.object({
  name: z.string(),
  username: z.string().nullable().optional(),
});
const messageSchema = z.object({
  message: z.object({ body: z.object({ mid: z.string() }) }),
});
const uploadEndpointSchema = z.object({
  url: z.string().url(),
  token: z.string().optional(),
});
const uploadResultSchema = z.object({ token: z.string().optional() }).passthrough();
const imageUploadResultSchema = z.object({
  token: z.string().optional(),
  photos: z.record(z.string(), z.object({ token: z.string() })).optional(),
}).passthrough();

class MaxApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`MAX API ${status} ${code}: ${message}`);
  }
}

export type MaxMessageAttachment =
  | { type: "image" | "video"; payload: object }
  | { type: "inline_keyboard"; payload: { buttons: MaxKeyboardButton[][] } };

export interface MaxKeyboardButton {
  type: "callback";
  text: string;
  payload: string;
}

export class MaxApiClient {
  constructor(
    private readonly token: string,
    private readonly timeoutMs = 20_000,
  ) {}

  async initialize(webhookUrl: string, webhookSecret: string): Promise<string> {
    const info = botInfoSchema.parse(await this.request("GET", "/me"));
    commandsSchema.parse(await this.request("PATCH", "/me/commands", {
      commands: [
        { name: "start", description: "Подписаться на бюллетени" },
        { name: "help", description: "Справка по командам" },
        { name: "stop", description: "Отключить уведомления" },
        { name: "weather", description: "Актуальный бюллетень" },
        { name: "details", description: "ECMWF и GFS отдельно" },
        { name: "forecast", description: "Прогноз на 5 дней" },
        { name: "points", description: "Контрольные точки" },
      { name: "status", description: "Статус обновления" },
      { name: "clouds", description: "Диагностика облаков" },
      { name: "radar", description: "Радар Sentinel-1" },
      { name: "map", description: "Настроить охват карты" },
      ],
    }));
    await this.ensureWebhook(webhookUrl, webhookSecret);
    return info.username ?? info.name;
  }

  async uploadImage(data: Uint8Array, filename: string): Promise<MaxMessageAttachment> {
    return this.uploadMedia("image", data, filename, 60_000);
  }

  async uploadVideo(data: Uint8Array, filename: string): Promise<MaxMessageAttachment> {
    return this.uploadMedia("video", data, filename, 120_000);
  }

  async sendMessage(
    userId: number,
    text: string,
    attachments: MaxMessageAttachment[] = [],
  ): Promise<string> {
    const result = messageSchema.parse(await this.withAttachmentRetry(() => this.request(
      "POST",
      "/messages",
      {
        text,
        format: "html",
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      { user_id: userId, disable_link_preview: true },
    )));
    return result.message.body.mid;
  }

  async editMessage(messageId: string, text: string): Promise<void> {
    assertAction(actionSchema.parse(await this.request(
      "PUT",
      "/messages",
      { text, format: "html" },
      { message_id: messageId },
    )));
  }

  async answerCallback(
    callbackId: string,
    message?: { text: string; attachments: MaxMessageAttachment[] },
    notification?: string,
  ): Promise<void> {
    assertAction(actionSchema.parse(await this.request(
      "POST",
      "/answers",
      {
        ...(message ? {
          message: {
            text: message.text,
            format: "html",
            attachments: message.attachments,
          },
        } : {}),
        ...(notification ? { notification } : {}),
      },
      { callback_id: callbackId },
    )));
  }

  async deleteMessage(messageId: string): Promise<void> {
    assertAction(actionSchema.parse(await this.request(
      "DELETE",
      "/messages",
      undefined,
      { message_id: messageId },
    )));
  }

  private async ensureWebhook(webhookUrl: string, webhookSecret: string): Promise<void> {
    const result = actionSchema.parse(await this.request("POST", "/subscriptions", {
      url: webhookUrl,
      update_types: ["message_created", "message_callback", "bot_started", "bot_stopped"],
      secret: webhookSecret,
    }));
    if (!result.success) throw new Error(`MAX webhook registration failed: ${result.message ?? "unknown error"}`);
  }

  private async request(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: object,
    query: Record<string, string | number | boolean> = {},
  ): Promise<unknown> {
    const url = new URL(path, MAX_API_BASE_URL);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: this.token,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data: unknown = await response.json();
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(data);
      throw error.success
        ? new MaxApiError(response.status, error.data.code, error.data.message)
        : new Error(`MAX API ${method} ${path} returned ${response.status}: ${JSON.stringify(data)}`);
    }
    return data;
  }

  private async withAttachmentRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!(error instanceof MaxApiError) || error.code !== "attachment.not.ready") throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async uploadMedia(
    type: "image" | "video",
    data: Uint8Array,
    filename: string,
    timeoutMs: number,
  ): Promise<MaxMessageAttachment> {
    const endpoint = uploadEndpointSchema.parse(await this.request("POST", "/uploads", undefined, { type }));
    const form = new FormData();
    const content = new Uint8Array(data);
    form.append("data", new Blob([content.buffer]), filename);
    const response = await fetch(endpoint.url, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(result);
      throw error.success
        ? new MaxApiError(response.status, error.data.code, error.data.message)
        : new Error(`MAX ${type} upload returned ${response.status}: ${JSON.stringify(result)}`);
    }
    if (type === "image") {
      const image = imageUploadResultSchema.parse(result);
      const token = endpoint.token ?? image.token;
      if (token) return { type, payload: { token } };
      if (image.photos) return { type, payload: { photos: image.photos } };
      throw new Error("MAX image upload response has no attachment token");
    }
    const token = endpoint.token ?? uploadResultSchema.parse(result).token;
    if (!token) throw new Error(`MAX ${type} upload response has no attachment token`);
    return { type, payload: { token } };
  }
}

function assertAction(result: z.infer<typeof actionSchema>): void {
  if (!result.success) throw new Error(`MAX action failed: ${result.message ?? "unknown error"}`);
}
