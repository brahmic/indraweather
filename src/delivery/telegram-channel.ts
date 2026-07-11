import { Bot, GrammyError, HttpError, InputFile } from "grammy";
import type { PublicationService } from "../application/publication-service.js";
import type { AppConfig } from "../config.js";
import type { DeliveryChannel, Publication } from "./types.js";
import { escapeHtml } from "../domain/bulletin.js";
import type { ControlPoint } from "../domain/types.js";
import type { Database } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";

export class TelegramChannel implements DeliveryChannel {
  readonly id = "telegram";
  readonly bot: Bot;

  constructor(
    token: string,
    private readonly database: Database,
    private readonly publications: PublicationService,
    private readonly points: ControlPoint[],
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.bot = new Bot(token);
    this.registerHandlers();
  }

  async start(): Promise<void> {
    await this.bot.api.setMyCommands([
      { command: "start", description: "Подписаться на бюллетени" },
      { command: "stop", description: "Отключить уведомления" },
      { command: "weather", description: "Актуальный бюллетень" },
      { command: "points", description: "Контрольные точки" },
      { command: "status", description: "Статус обновления" },
    ]);
    this.bot.start({
      onStart: ({ username }) => this.logger.info({ username }, "Telegram bot started"),
    }).catch((error: unknown) => this.logger.error({ error }, "Telegram polling stopped"));
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }

  async broadcast(publication: Publication): Promise<void> {
    const recipientIds = await this.database.getActiveRecipientIds(this.id);
    await Promise.allSettled(
      recipientIds.map((recipientId) => this.deliver(recipientId, publication)),
    );
  }

  private registerHandlers(): void {
    this.bot.command("start", async (ctx) => {
      if (ctx.chat.type !== "private") {
        await ctx.reply("Подписка доступна только в личном чате с ботом.");
        return;
      }
      await this.database.subscribe(this.id, String(ctx.chat.id));
      await ctx.reply(
        "Подписка включена. Бюллетени приходят ежедневно в 05:00, 11:00, 17:00 и 23:00 МСК. Отключить: /stop",
      );
    });

    this.bot.command("stop", async (ctx) => {
      await this.database.unsubscribe(this.id, String(ctx.chat.id));
      await ctx.reply("Автоматические уведомления отключены. Возобновить: /start");
    });

    this.bot.command("weather", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      try {
        const publication = await this.publications.getFreshOrRun();
        await this.sendPublication(String(ctx.chat.id), publication);
      } catch (error) {
        this.logger.error({ error }, "Manual bulletin failed");
        await ctx.reply("Не удалось сформировать бюллетень: погодные данные временно недоступны.");
      }
    });

    this.bot.command("points", async (ctx) => {
      const lines = this.points.filter((point) => point.active).map((point) =>
        `• ${escapeHtml(point.name)}: <code>${point.latitude.toFixed(3)}, ${point.longitude.toFixed(3)}</code>`);
      await ctx.reply(`<b>Контрольные точки</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
    });

    this.bot.command("status", async (ctx) => {
      const updatedAt = await this.database.getLastSuccessfulUpdate();
      const text = updatedAt
        ? new Intl.DateTimeFormat("ru-RU", {
          timeZone: this.config.timeZone,
          dateStyle: "medium",
          timeStyle: "short",
        }).format(updatedAt)
        : "успешных обновлений ещё не было";
      await ctx.reply(`Последнее успешное обновление: ${text}${updatedAt ? " МСК" : ""}.`);
    });

    this.bot.catch((error) => {
      const cause = error.error;
      if (cause instanceof GrammyError) {
        this.logger.error({ description: cause.description }, "Telegram API error");
      } else if (cause instanceof HttpError) {
        this.logger.error({ cause }, "Telegram network error");
      } else {
        this.logger.error({ cause }, "Telegram handler error");
      }
    });
  }

  private async deliver(recipientId: string, publication: Publication): Promise<void> {
    if (!await this.database.claimDelivery(publication.id, this.id, recipientId)) return;
    try {
      const messages = await this.sendPublication(recipientId, publication);
      const lastMessage = messages.at(-1);
      await this.database.markDelivery(
        publication.id,
        this.id,
        recipientId,
        "sent",
        lastMessage ? String(lastMessage.message_id) : null,
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
      if (/bot was blocked|chat not found|user is deactivated/iu.test(message)) {
        await this.database.unsubscribe(this.id, recipientId);
      }
      this.logger.warn({ recipientId, error: message }, "Telegram delivery failed");
    }
  }

  private async sendPublication(recipientId: string, publication: Publication) {
    const messages = [];
    for (const attachment of publication.attachments) {
      if (attachment.kind === "image") {
        messages.push(await this.bot.api.sendPhoto(
          recipientId,
          new InputFile(attachment.data, attachment.filename),
          { caption: attachment.caption },
        ));
      }
    }
    messages.push(...await this.sendContent(recipientId, publication.text));
    return messages;
  }

  private async sendContent(recipientId: string, content: string) {
    const chunks = splitMessage(content, 3900);
    const messages = [];
    for (const chunk of chunks) {
      messages.push(await this.bot.api.sendMessage(recipientId, chunk, {
        link_preview_options: { is_disabled: true },
      }));
    }
    return messages;
  }
}

export function splitMessage(content: string, limit: number): string[] {
  if (content.length <= limit) return [content];
  const chunks: string[] = [];
  let current = "";
  for (const line of content.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    if (line.length <= limit) {
      current = line;
      continue;
    }
    for (let offset = 0; offset < line.length; offset += limit) {
      chunks.push(line.slice(offset, offset + limit));
    }
    current = "";
  }
  if (current) chunks.push(current);
  return chunks;
}
