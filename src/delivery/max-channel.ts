import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PublicationService } from "../application/publication-service.js";
import type { AppConfig } from "../config.js";
import { escapeHtml } from "../domain/bulletin.js";
import type { ControlPoint } from "../domain/types.js";
import type { Database, MaxWebhookRecord } from "../infrastructure/database.js";
import type { MaxApiClient, MaxMessageAttachment } from "../infrastructure/max-api.js";
import type { Logger } from "../logger.js";
import { formatPostHtml, splitText } from "./post-format.js";
import type { DeliveryChannel, Publication } from "./types.js";

const userSchema = z.object({
  user_id: z.number(),
  is_bot: z.boolean().optional().default(false),
}).passthrough();

const updateSchema = z.discriminatedUnion("update_type", [
  z.object({
    update_type: z.literal("bot_started"),
    timestamp: z.number(),
    chat_id: z.number(),
    user: userSchema,
  }).passthrough(),
  z.object({
    update_type: z.literal("bot_stopped"),
    timestamp: z.number(),
    chat_id: z.number(),
    user: userSchema.optional(),
  }).passthrough(),
  z.object({
    update_type: z.literal("message_created"),
    timestamp: z.number(),
    message: z.object({
      sender: userSchema.nullable().optional(),
      recipient: z.object({
        chat_id: z.number().nullable(),
        chat_type: z.enum(["dialog", "chat", "channel"]),
      }),
      body: z.object({ mid: z.string(), text: z.string().nullable() }),
    }).passthrough(),
  }).passthrough(),
]);

type MaxWebhookUpdate = z.infer<typeof updateSchema>;

interface MaxApi {
  initialize(webhookUrl: string, webhookSecret: string): Promise<string>;
  uploadImage(data: Uint8Array): Promise<MaxMessageAttachment>;
  uploadVideo(data: Uint8Array): Promise<MaxMessageAttachment>;
  sendMessage(
    userId: number,
    text: string,
    attachments?: MaxMessageAttachment[],
  ): Promise<string>;
  editMessage(messageId: string, text: string): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

interface PreparedAttachment {
  caption: string;
  attachment: MaxMessageAttachment;
}

export type MaxWebhookResult = "accepted" | "unauthorized" | "invalid";

export class MaxChannel implements DeliveryChannel {
  readonly id = "max";
  readonly webhookPath = "/webhooks/max";
  private readonly webhookSecret: string;
  private worker: Promise<void> | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private configureTimer: NodeJS.Timeout | null = null;
  private configured = false;

  constructor(
    token: string,
    publicBaseUrl: string,
    private readonly database: Database,
    private readonly publications: PublicationService,
    private readonly points: ControlPoint[],
    private readonly config: AppConfig,
    private readonly api: MaxApi,
    private readonly logger: Logger,
  ) {
    this.webhookSecret = createHash("sha256")
      .update("indra:max-webhook:v1\0")
      .update(token)
      .digest("hex");
    this.webhookUrl = `${publicBaseUrl}${this.webhookPath}`;
  }

  private readonly webhookUrl: string;

  async start(): Promise<void> {
    await this.database.resetProcessingMaxWebhooks();
    await this.configure();
    this.queueTimer = setInterval(() => this.kick(), 15_000);
    this.configureTimer = setInterval(() => {
      if (!this.configured) void this.configure();
    }, 5 * 60_000);
    this.kick();
  }

  async stop(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer);
    if (this.configureTimer) clearInterval(this.configureTimer);
    this.queueTimer = null;
    this.configureTimer = null;
    await this.worker;
  }

  async broadcast(publication: Publication): Promise<void> {
    const recipientIds = await this.database.getActiveRecipientIds(this.id);
    const prepared = this.prepareAttachments(publication);
    await Promise.allSettled(recipientIds.map((recipientId) =>
      this.deliver(recipientId, publication, prepared)));
  }

  async acceptWebhook(secret: string | undefined, rawBody: string): Promise<MaxWebhookResult> {
    if (!secureEqual(secret, this.webhookSecret)) return "unauthorized";
    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return "invalid";
    }
    const parsed = updateSchema.safeParse(json);
    if (!parsed.success) {
      this.logger.warn({ issues: parsed.error.issues }, "Invalid MAX webhook payload");
      return "invalid";
    }
    const fingerprint = createHash("sha256").update(rawBody).digest("hex");
    if (await this.database.enqueueMaxWebhook(fingerprint, parsed.data)) this.kick();
    return "accepted";
  }

  private async configure(): Promise<void> {
    try {
      const username = await this.api.initialize(this.webhookUrl, this.webhookSecret);
      this.configured = true;
      this.logger.info({ username, webhookUrl: this.webhookUrl }, "MAX bot started");
    } catch (error) {
      this.configured = false;
      this.logger.error({ error }, "MAX bot setup failed; retry scheduled");
    }
  }

  private kick(): void {
    if (this.worker) return;
    this.worker = this.processQueue()
      .catch((error: unknown) => this.logger.error({ error }, "MAX webhook worker failed"))
      .finally(() => {
        this.worker = null;
      });
  }

  private async processQueue(): Promise<void> {
    let record: MaxWebhookRecord | null;
    while ((record = await this.database.claimMaxWebhook())) {
      try {
        await this.processUpdate(updateSchema.parse(record.payload));
        await this.database.completeMaxWebhook(record.fingerprint);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.database.failMaxWebhook(record.fingerprint, message, record.attempts);
        this.logger.warn({ error, fingerprint: record.fingerprint }, "MAX webhook processing failed");
      }
    }
  }

  private async processUpdate(update: MaxWebhookUpdate): Promise<void> {
    if (update.update_type === "bot_started") {
      await this.subscribeAndWelcome(update.user.user_id);
      return;
    }
    if (update.update_type === "bot_stopped") {
      await this.database.unsubscribe(this.id, String(update.user?.user_id ?? update.chat_id));
      return;
    }
    const sender = update.message.sender;
    const text = update.message.body.text?.trim();
    if (!sender || sender.is_bot || !text || update.message.recipient.chat_type !== "dialog") return;
    const command = parseCommand(text);
    switch (command) {
      case "start":
        await this.subscribeAndWelcome(sender.user_id);
        break;
      case "stop":
        await this.database.unsubscribe(this.id, String(sender.user_id));
        await this.api.sendMessage(sender.user_id, "Автоматические уведомления отключены. Возобновить: /start");
        break;
      case "weather":
        await this.sendWeather(sender.user_id);
        break;
      case "details":
        await this.sendText(sender.user_id, await this.publications.getFreshDetails());
        break;
      case "points":
        await this.sendPoints(sender.user_id);
        break;
      case "status":
        await this.sendStatus(sender.user_id);
        break;
      case "clouds":
        await this.sendDiagnostic(sender.user_id, () => this.publications.getClouds(), "Диагностический снимок облаков временно недоступен.");
        break;
      case "radar":
        await this.sendDiagnostic(sender.user_id, () => this.publications.getRadar(), "Радар Sentinel-1 временно недоступен или ещё не настроен.");
        break;
    }
  }

  private async subscribeAndWelcome(userId: number): Promise<void> {
    await this.database.subscribe(this.id, String(userId));
    await this.api.sendMessage(
      userId,
      "Подписка включена. Бюллетени приходят ежедневно в 05:00, 11:00, 17:00 и 23:00 МСК. Отключить: /stop",
    );
  }

  private async sendWeather(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Собираю прогноз и спутниковые снимки…");
    try {
      const publication = await this.publications.getFreshOrRun();
      await this.sendPublication(userId, publication, this.prepareAttachments(publication));
      await this.api.deleteMessage(progressId).catch((error: unknown) => {
        this.logger.debug({ error }, "Failed to remove MAX weather progress message");
      });
    } catch (error) {
      this.logger.error({ error }, "MAX manual bulletin failed");
      await this.api.editMessage(
        progressId,
        "Не удалось сформировать бюллетень: погодные данные временно недоступны.",
      ).catch(() => undefined);
    }
  }

  private async sendPoints(userId: number): Promise<void> {
    const lines = this.points.filter((point) => point.active).map((point) =>
      `• ${escapeHtml(point.name)}: <code>${point.latitude.toFixed(3)}, ${point.longitude.toFixed(3)}</code>`);
    await this.api.sendMessage(userId, `<b>Контрольные точки</b>\n${lines.join("\n")}`);
  }

  private async sendStatus(userId: number): Promise<void> {
    const updatedAt = await this.database.getLastSuccessfulUpdate();
    const text = updatedAt
      ? `${new Intl.DateTimeFormat("ru-RU", {
        timeZone: this.config.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(updatedAt)} МСК`
      : "успешных обновлений ещё не было";
    await this.api.sendMessage(userId, `Последнее успешное обновление: ${text}.`);
  }

  private async sendDiagnostic(userId: number, getAttachment: () => Promise<import("./types.js").ImageAttachment>, failure: string): Promise<void> {
    try {
      const attachment = await getAttachment();
      const uploaded = await this.api.uploadImage(attachment.data);
      await this.api.sendMessage(userId, formatPostHtml(attachment.caption, [], true), [uploaded]);
    } catch (error) {
      this.logger.warn({ err: error }, "MAX satellite diagnostic request failed");
      await this.api.sendMessage(userId, failure);
    }
  }

  private async prepareAttachments(publication: Publication): Promise<PreparedAttachment[]> {
    const attachments: PreparedAttachment[] = [];
    for (const attachment of publication.attachments) {
      const uploaded = attachment.kind === "image"
        ? await this.api.uploadImage(attachment.data)
        : await this.api.uploadVideo(attachment.data);
      attachments.push({
        caption: attachment.caption,
        attachment: uploaded,
      });
    }
    return attachments;
  }

  private async deliver(
    recipientId: string,
    publication: Publication,
    prepared: Promise<PreparedAttachment[]>,
  ): Promise<void> {
    if (!await this.database.claimDelivery(publication.id, this.id, recipientId)) return;
    try {
      const messageIds = await this.sendPublication(
        parseRecipientId(recipientId),
        publication,
        prepared,
      );
      await this.database.markDelivery(
        publication.id,
        this.id,
        recipientId,
        "sent",
        messageIds.at(-1) ?? null,
        null,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.database.markDelivery(
        publication.id,
        this.id,
        recipientId,
        "failed",
        null,
        message.slice(0, 2000),
      );
      if (/blocked|not found|access denied|chat.denied/iu.test(message)) {
        await this.database.unsubscribe(this.id, recipientId);
      }
      this.logger.warn({ recipientId, error: message }, "MAX delivery failed");
    }
  }

  private async sendPublication(
    userId: number,
    publication: Publication,
    prepared: Promise<PreparedAttachment[]>,
  ): Promise<string[]> {
    const messageIds: string[] = [];
    for (const item of await prepared) {
      messageIds.push(await this.api.sendMessage(
        userId,
        formatPostHtml(item.caption, [], true),
        [item.attachment],
      ));
    }
    messageIds.push(...await this.sendText(userId, publication.text));
    return messageIds;
  }

  private async sendText(userId: number, content: string): Promise<string[]> {
    const chunks = splitText(content, 3400);
    const messageIds: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      messageIds.push(await this.api.sendMessage(
        userId,
        formatPostHtml(chunk, this.points.map((point) => point.name), index === 0),
      ));
    }
    return messageIds;
  }
}

function secureEqual(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCommand(text: string): string | null {
  const token = text.split(/\s/u, 1)[0];
  if (!token?.startsWith("/")) return null;
  return token.slice(1).split("@", 1)[0]?.toLocaleLowerCase("en-US") ?? null;
}

function parseRecipientId(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid MAX user id: ${value}`);
  return result;
}
