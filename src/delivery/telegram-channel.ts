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
      { command: "details", description: "ECMWF и GFS отдельно" },
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

    this.bot.command("details", async (ctx) => {
      await ctx.replyWithChatAction("typing");
      try {
        await this.sendContent(String(ctx.chat.id), await this.publications.getFreshDetails());
      } catch (error) {
        this.logger.error({ error }, "Detailed model bulletin failed");
        await ctx.reply("Не удалось сформировать детализацию: погодные данные временно недоступны.");
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
    const chunks = splitMessage(content, 3400);
    const messages = [];
    for (const [index, chunk] of chunks.entries()) {
      messages.push(await this.bot.api.sendMessage(recipientId, formatTelegramPost(
        chunk,
        this.points.map((point) => point.name),
        index === 0,
      ), {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }));
    }
    return messages;
  }
}

export function formatTelegramPost(
  content: string,
  pointNames: string[],
  includeTitle = true,
): string {
  return content.split("\n").map((line, index) => {
    if (!line) return "";
    if (includeTitle && index === 0) return `🌊 <b>${escapeHtml(line)}</b>`;

    const pointName = pointNames.find((name) => line === name || line.startsWith(`${name}:`));
    if (pointName) {
      const remainder = line.slice(pointName.length);
      return `📍 <b>${escapeHtml(pointName)}${remainder.startsWith(":") ? ":" : ""}</b>${escapeHtml(remainder.replace(/^:/u, ""))}`;
    }

    const labelled = formatLabel(line);
    return labelled ?? escapeHtml(line);
  }).join("\n");
}

function formatLabel(line: string): string | null {
  const labels: Array<[prefix: string, icon: string, wholeLine?: boolean]> = [
    ["Официальное предупреждение", "⚠️", true],
    ["Официальные предупреждения:", "⚠️"],
    ["Неполные данные:", "⚠️"],
    ["Главное:", "📌"],
    ["Главное", "📌", true],
    ["Сформировано:", "🕒"],
    ["Верхняя граница моделей:", "🌬️"],
    ["Согласованность:", "🔎"],
    ["Контрольные точки", "📍", true],
    ["Диапазоны:", "ℹ️"],
    ["Сводный коридор ECMWF/GFS", "🌬️", true],
    ["Обстановка", "🧭", true],
    ["Поворот ветра:", "🧭"],
    ["Модели:", "🔎"],
    ["Давление:", "📈"],
    ["Следующие 24 часа:", "⏱️"],
    ["Период 24–48 часов:", "⏱️"],
    ["Прилив:", "🌊"],
    ["Выпуск", "🗓️", true],
    ["Изменение:", "🔄"],
    ["Следующий выпуск:", "🕒"],
    ["Детальный снимок Sentinel-3 пропущен:", "🛰️"],
    ["Период:", "🗓️"],
    ["ECMWF:", "  •"],
    ["GFS:", "  •"],
    ["Расхождение:", "  ↔"],
    ["Итог сравнения:", "📊"],
    ["Источники", "ℹ️", true],
    ["Погода:", "  •"],
    ["Приливы:", "  •"],
    ["Ветер", "  •"],
    ["Осадки", "  •"],
    ["Видимость", "  •"],
    ["Температура", "  •"],
    ["Данные:", "ℹ️"],
    ["Источник:", "ℹ️"],
  ];
  const match = labels.find(([prefix]) => line.startsWith(prefix));
  if (!match) return null;
  const [prefix, icon, wholeLine] = match;
  if (wholeLine) return `${icon} <b>${escapeHtml(line)}</b>`;
  return `${icon} <b>${escapeHtml(prefix)}</b>${escapeHtml(line.slice(prefix.length))}`;
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
