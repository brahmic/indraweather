import { Bot, GrammyError, HttpError, InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import type { PublicationService } from "../application/publication-service.js";
import type { PersonalAnimationService } from "../application/personal-animation-service.js";
import type { AppConfig } from "../config.js";
import type { DeliveryAttachment, DeliveryChannel, Publication } from "./types.js";
import { escapeHtml } from "../domain/bulletin.js";
import {
  changeMapViewport,
  createMapViewport,
  formatMapExtent,
  type MapViewport,
  type MapViewportAction,
} from "../domain/map-viewport.js";
import type { ControlPoint } from "../domain/types.js";
import type { Database } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";
import { formatPostHtml, splitText } from "./post-format.js";

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
    private readonly personalAnimations: PersonalAnimationService | null = null,
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
      { command: "clouds", description: "Диагностика облаков" },
      { command: "radar", description: "Радар Sentinel-1" },
      { command: "map", description: "Настроить охват карты" },
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
      const progress = await ctx.reply("⏳ Собираю прогноз и спутниковые снимки…");
      try {
        const map = await this.getMapSelection(String(ctx.chat.id));
        const publication = await this.publications.getFreshOrRun(
          map.viewport,
          !map.isCustom,
        );
        await this.sendPublication(String(ctx.chat.id), publication);
        await ctx.api.deleteMessage(ctx.chat.id, progress.message_id).catch((error: unknown) => {
          this.logger.debug({ error }, "Failed to remove weather progress message");
        });
        if (map.isCustom) this.enqueuePersonalAnimation("satellite", String(ctx.chat.id), map.viewport);
      } catch (error) {
        this.logger.error({ error }, "Manual bulletin failed");
        const failure = "Не удалось сформировать бюллетень: погодные данные временно недоступны.";
        await ctx.api.editMessageText(ctx.chat.id, progress.message_id, failure)
          .catch(async () => ctx.reply(failure));
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

    this.bot.command("clouds", async (ctx) => {
      const map = await this.getMapSelection(String(ctx.chat.id));
      const sent = await this.sendDiagnostic(
        ctx.chat.id,
        async () => this.publications.getClouds(map.viewport, !map.isCustom),
        "Диагностический снимок облаков временно недоступен.",
      );
      if (sent && map.isCustom) this.enqueuePersonalAnimation("clouds", String(ctx.chat.id), map.viewport);
    });

    this.bot.command("radar", async (ctx) => {
      await this.sendDiagnostic(
        ctx.chat.id,
        async () => [await this.publications.getRadar(await this.getMapViewport(String(ctx.chat.id)))],
        "Радар Sentinel-1 временно недоступен или ещё не настроен.",
      );
    });

    this.bot.command("map", async (ctx) => {
      if (ctx.chat.type !== "private") {
        await ctx.reply("Настройка карты доступна только в личном чате с ботом.");
        return;
      }
      await ctx.replyWithChatAction("upload_photo");
      try {
        const viewport = await this.getMapViewport(String(ctx.chat.id));
        const image = await this.publications.getMap(viewport);
        await ctx.replyWithPhoto(new InputFile(image.data, image.filename), {
          caption: this.mapCaption(image.caption, viewport),
          reply_markup: this.mapKeyboard(),
        });
      } catch (error) {
        this.logger.warn({ err: error }, "Map request failed");
        await ctx.reply("Карту сейчас получить не удалось. Попробуйте ещё раз через минуту.");
      }
    });

    this.bot.callbackQuery(/^map:(up|down|left|right|zoom-in|zoom-out|refresh)$/u, async (ctx) => {
      if (!ctx.chat || ctx.chat.type !== "private") {
        await ctx.answerCallbackQuery({ text: "Настройка доступна только в личном чате." });
        return;
      }
      const action = ctx.match[1] as MapViewportAction | undefined;
      if (!action) return;
      await ctx.answerCallbackQuery();
      try {
        const current = await this.getMapViewport(String(ctx.chat.id));
        const viewport = action === "refresh"
          ? current
          : changeMapViewport(current, action);
        if (action !== "refresh") {
          await this.database.saveMapViewport(this.id, String(ctx.chat.id), viewport.bbox);
        }
        const image = await this.publications.getMap(viewport);
        await ctx.editMessageMedia(
          InputMediaBuilder.photo(new InputFile(image.data, image.filename), {
            caption: this.mapCaption(image.caption, viewport),
          }),
          { reply_markup: this.mapKeyboard() },
        );
      } catch (error) {
        this.logger.warn({ err: error }, "Map update failed");
        await ctx.reply("Карту сейчас обновить не удалось. Попробуйте ещё раз через минуту.");
      }
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
      messages.push(await this.sendAttachment(recipientId, attachment));
    }
    messages.push(...await this.sendContent(recipientId, publication.text));
    return messages;
  }

  private async sendDiagnostic(
    chatId: number,
    getAttachments: () => Promise<DeliveryAttachment[]>,
    failure: string,
  ): Promise<boolean> {
    try {
      for (const attachment of await getAttachments()) {
        await this.sendAttachment(chatId, attachment);
      }
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, "Satellite diagnostic request failed");
      await this.bot.api.sendMessage(chatId, failure);
      return false;
    }
  }

  private async getMapViewport(recipientId: string): Promise<MapViewport> {
    return (await this.getMapSelection(recipientId)).viewport;
  }

  private async getMapSelection(recipientId: string): Promise<{ viewport: MapViewport; isCustom: boolean }> {
    const saved = await this.database.getMapViewport(this.id, recipientId);
    return {
      viewport: createMapViewport(
        saved ?? this.config.satellite.bbox,
        this.config.satellite.width,
        this.config.satellite.height,
      ),
      isCustom: saved !== null,
    };
  }

  private enqueuePersonalAnimation(
    kind: "satellite" | "clouds",
    recipientId: string,
    viewport: MapViewport,
  ): void {
    if (!this.personalAnimations) return;
    void this.personalAnimations.request(this.id, recipientId, kind, viewport).catch((error: unknown) =>
      this.logger.warn({ err: error, kind, recipientId }, "Personal animation request failed"));
  }

  private mapKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("↑", "map:up")
      .row()
      .text("←", "map:left")
      .text("⟳", "map:refresh")
      .text("→", "map:right")
      .row()
      .text("↓", "map:down")
      .row()
      .text("−", "map:zoom-out")
      .text("+", "map:zoom-in");
  }

  private mapCaption(caption: string, viewport: MapViewport): string {
    return `${caption}\n${formatMapExtent(viewport)}`;
  }

  private async sendAttachment(chatId: string | number, attachment: DeliveryAttachment) {
    if (attachment.kind === "image") {
      return this.bot.api.sendPhoto(
        chatId,
        new InputFile(attachment.data, attachment.filename),
        { caption: attachment.caption },
      );
    }
    return this.bot.api.sendVideo(
      chatId,
      new InputFile(attachment.data, attachment.filename),
      { caption: attachment.caption, supports_streaming: true },
    );
  }

  async sendPersonalAnimation(recipientId: string, attachment: DeliveryAttachment): Promise<void> {
    await this.sendAttachment(recipientId, attachment);
  }

  private async sendContent(recipientId: string, content: string) {
    const chunks = splitText(content, 3400);
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
  return formatPostHtml(content, pointNames, includeTitle);
}

export function splitMessage(content: string, limit: number): string[] {
  return splitText(content, limit);
}
