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
import { formatHelpHtml } from "./help-text.js";
import { formatPersonalCloudMotionStatus } from "./cloud-motion.js";

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
      { command: "help", description: "Справка по командам" },
      { command: "stop", description: "Отключить уведомления" },
      { command: "weather", description: "Актуальный бюллетень" },
      { command: "details", description: "ECMWF и GFS отдельно" },
      { command: "animation", description: "Движение облаков" },
      { command: "forecast", description: "Прогноз погоды" },
      { command: "points", description: "Контрольные точки" },
      { command: "status", description: "Статус обновления" },
      { command: "clouds", description: "Облачность и ИК-снимок" },
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
      await ctx.reply(formatHelpHtml(this.config.scheduleTimes, true), {
        parse_mode: "HTML",
        reply_markup: this.startKeyboard(),
      });
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply(formatHelpHtml(this.config.scheduleTimes), {
        parse_mode: "HTML",
        reply_markup: this.helpKeyboard(),
      });
    });

    this.bot.command("stop", async (ctx) => {
      await this.stopSubscription(ctx.chat.id);
    });

    this.bot.command("weather", async (ctx) => {
      await this.sendWeather(ctx.chat.id);
    });

    this.bot.command("update", async (ctx) => {
      if (ctx.chat.type !== "private") {
        await ctx.reply("Команда доступна только в личном чате.");
        return;
      }
      if (!await this.canForceUpdate(ctx.chat.id)) {
        this.logger.warn({ chatId: ctx.chat.id }, "Unauthorized Telegram manual update request");
        await ctx.reply("Команда недоступна.");
        return;
      }
      await this.sendForcedUpdate(ctx.chat.id);
    });

    this.bot.command("details", async (ctx) => {
      await this.sendDetails(ctx.chat.id);
    });

    this.bot.command("animation", async (ctx) => {
      await this.sendCloudMotion(ctx.chat.id);
    });

    this.bot.command("forecast", async (ctx) => {
      await this.sendPointForecastPicker(ctx.chat.id);
    });

    this.bot.command("points", async (ctx) => {
      await this.sendPoints(ctx.chat.id);
    });

    this.bot.command("status", async (ctx) => {
      await this.sendStatus(ctx.chat.id);
    });

    this.bot.command("clouds", async (ctx) => {
      await this.sendClouds(ctx.chat.id);
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

    this.bot.callbackQuery(/^forecast:([a-z0-9-]+)$/u, async (ctx) => {
      const pointId = ctx.match[1];
      const point = this.points.find((item) => item.id === pointId && item.active);
      const chatId = ctx.chat?.id;
      if (!point) {
        await ctx.answerCallbackQuery({ text: "Точка больше не активна." });
        return;
      }
      if (chatId === undefined) {
        await ctx.answerCallbackQuery({ text: "Сообщение больше недоступно." });
        return;
      }
      await ctx.answerCallbackQuery({ text: `⏳ Готовлю прогноз для ${point.shortName}…` });
      try {
        const content = await this.publications.getPointForecast(point.id);
        if (ctx.callbackQuery.message && "photo" in ctx.callbackQuery.message) {
          await this.sendContent(String(chatId), content);
          return;
        }
        await ctx.editMessageText(formatTelegramPost(content, this.points.map((item) => item.name)), {
          parse_mode: "HTML",
          link_preview_options: { is_disabled: true },
          reply_markup: { inline_keyboard: [] },
        });
      } catch (error) {
        this.logger.error({ error, pointId }, "Point forecast request failed");
        if (ctx.callbackQuery.message && "photo" in ctx.callbackQuery.message) {
          await this.bot.api.sendMessage(chatId, "Не удалось подготовить пятидневный прогноз. Попробуйте ещё раз через минуту.");
          return;
        }
        await ctx.editMessageText("Не удалось подготовить пятидневный прогноз. Попробуйте ещё раз через минуту.", {
          reply_markup: { inline_keyboard: [] },
        }).catch(() => undefined);
      }
    });

    this.bot.callbackQuery(/^bulletin:(details|clouds|forecast|animation)$/u, async (ctx) => {
      const action = ctx.match[1];
      if (!ctx.chat) {
        await ctx.answerCallbackQuery({ text: "Сообщение больше недоступно." });
        return;
      }
      await ctx.answerCallbackQuery();
      if (action === "details") await this.sendDetails(ctx.chat.id);
      else if (action === "clouds") await this.sendClouds(ctx.chat.id);
      else if (action === "animation") await this.sendCloudMotion(ctx.chat.id);
      else await this.sendPointForecastPicker(ctx.chat.id);
    });

    this.bot.callbackQuery(/^help:(points|status|stop|weather|forecast)$/u, async (ctx) => {
      const action = ctx.match[1];
      if (!ctx.chat) {
        await ctx.answerCallbackQuery({ text: "Сообщение больше недоступно." });
        return;
      }
      await ctx.answerCallbackQuery();
      if (action === "points") await this.sendPoints(ctx.chat.id);
      else if (action === "status") await this.sendStatus(ctx.chat.id);
      else if (action === "stop") await this.stopSubscription(ctx.chat.id);
      else if (action === "weather") await this.sendWeather(ctx.chat.id);
      else await this.sendPointForecastPicker(ctx.chat.id);
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
    const images = publication.attachments.filter((attachment) => attachment.kind === "image");
    if (images.length >= 2) {
      messages.push(...await this.bot.api.sendMediaGroup(recipientId, images.map((attachment) =>
        InputMediaBuilder.photo(new InputFile(attachment.data, attachment.filename), {
          caption: attachment.caption,
        }))));
    } else {
      for (const attachment of images) {
        messages.push(await this.sendAttachment(recipientId, attachment));
      }
    }
    for (const attachment of publication.attachments.filter((item) => item.kind !== "image")) {
      messages.push(await this.sendAttachment(recipientId, attachment));
    }
    messages.push(...await this.sendContent(recipientId, publication.text, this.bulletinKeyboard()));
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

  private async sendDetails(chatId: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, "typing");
    try {
      const details = await this.publications.getFreshDetails();
      await this.sendContent(String(chatId), details.text);
    } catch (error) {
      this.logger.error({ error }, "Detailed model bulletin failed");
      await this.bot.api.sendMessage(chatId, "Не удалось сформировать детализацию: погодные данные временно недоступны.");
    }
  }

  private async sendWeather(chatId: number): Promise<void> {
    const progress = await this.bot.api.sendMessage(chatId, "⏳ Собираю прогноз и спутниковые снимки…");
    try {
      const map = await this.getMapSelection(String(chatId));
      const publication = await this.publications.getFreshOrRun(map.viewport);
      await this.sendPublication(String(chatId), publication);
      await this.bot.api.deleteMessage(chatId, progress.message_id).catch((error: unknown) => {
        this.logger.debug({ error }, "Failed to remove weather progress message");
      });
    } catch (error) {
      this.logger.error({ error }, "Manual bulletin failed");
      const failure = "Не удалось сформировать бюллетень: погодные данные временно недоступны.";
      await this.bot.api.editMessageText(chatId, progress.message_id, failure)
        .catch(() => this.bot.api.sendMessage(chatId, failure));
    }
  }

  private async sendForcedUpdate(chatId: number): Promise<void> {
    const progress = await this.bot.api.sendMessage(chatId, "⏳ Принудительно обновляю бюллетень…");
    try {
      const map = await this.getMapSelection(String(chatId));
      const publication = await this.publications.run({ kind: "manual" }, map.viewport);
      if (!publication) {
        await this.bot.api.editMessageText(chatId, progress.message_id, "Сбор уже выполняется. Попробуйте через минуту.");
        return;
      }
      await this.sendPublication(String(chatId), publication);
      await this.bot.api.deleteMessage(chatId, progress.message_id).catch((error: unknown) => {
        this.logger.debug({ error }, "Failed to remove manual update progress message");
      });
    } catch (error) {
      this.logger.error({ error }, "Telegram manual update failed");
      await this.bot.api.editMessageText(
        chatId,
        progress.message_id,
        "Не удалось обновить бюллетень: погодные данные временно недоступны.",
      ).catch(() => undefined);
    }
  }

  private async sendPointForecastPicker(chatId: number): Promise<void> {
    await this.bot.api.sendChatAction(chatId, "upload_photo");
    try {
      const image = await this.publications.getForecastMap(
        await this.getMapViewport(String(chatId)),
      );
      await this.bot.api.sendPhoto(chatId, new InputFile(image.data, image.filename), {
        caption: forecastPickerText(image.caption),
        parse_mode: "HTML",
        reply_markup: this.forecastKeyboard(),
      });
    } catch (error) {
      this.logger.warn({ err: error, chatId }, "Forecast map request failed");
      await this.bot.api.sendMessage(chatId, forecastPickerText(), {
        parse_mode: "HTML",
        reply_markup: this.forecastKeyboard(),
      });
    }
  }

  private async sendCloudMotion(chatId: number): Promise<void> {
    const progress = await this.bot.api.sendMessage(chatId, "⏳ Готовлю анимацию движения облаков…");
    try {
      const map = await this.getMapSelection(String(chatId));
      if (map.isCustom) {
        const results = await Promise.all([
          this.requestPersonalAnimation("satellite", String(chatId), map.viewport),
          this.requestPersonalAnimation("clouds", String(chatId), map.viewport),
        ]);
        await this.bot.api.editMessageText(
          chatId,
          progress.message_id,
          formatPersonalCloudMotionStatus(results),
        );
        return;
      }
      for (const attachment of await this.publications.getCloudMotionAnimations()) {
        await this.sendAttachment(chatId, attachment);
      }
      await this.bot.api.deleteMessage(chatId, progress.message_id).catch((error: unknown) =>
        this.logger.debug({ error }, "Failed to remove cloud motion progress message"));
    } catch (error) {
      this.logger.error({ error }, "Cloud motion request failed");
      await this.bot.api.editMessageText(
        chatId,
        progress.message_id,
        "Анимации пока недоступны: недостаточно кадров или источник временно не отвечает.",
      ).catch(() => undefined);
    }
  }

  private async sendClouds(chatId: number): Promise<void> {
    const progress = await this.bot.api.sendMessage(chatId, "⏳ Собираю информацию об облачности…");
    try {
      const map = await this.getMapSelection(String(chatId));
      await this.sendDiagnostic(
        chatId,
        async () => this.publications.getClouds(map.viewport),
        "Диагностический снимок облаков временно недоступен.",
      );
    } catch (error) {
      this.logger.error({ error }, "Cloud diagnostic request failed");
      await this.bot.api.sendMessage(chatId, "Диагностический снимок облаков временно недоступен.");
    } finally {
      await this.bot.api.deleteMessage(chatId, progress.message_id).catch((error: unknown) =>
        this.logger.debug({ error }, "Failed to remove clouds progress message"));
    }
  }

  private async sendPoints(chatId: number): Promise<void> {
    const lines = this.points.filter((point) => point.active).map((point) =>
      `• ${escapeHtml(point.name)}: <code>${point.latitude.toFixed(3)}, ${point.longitude.toFixed(3)}</code>`);
    await this.bot.api.sendMessage(chatId, `<b>Контрольные точки</b>\n${lines.join("\n")}`, { parse_mode: "HTML" });
  }

  private async sendStatus(chatId: number): Promise<void> {
    const updatedAt = await this.database.getLastSuccessfulUpdate();
    const text = updatedAt
      ? new Intl.DateTimeFormat("ru-RU", {
        timeZone: this.config.timeZone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(updatedAt)
      : "успешных обновлений ещё не было";
    await this.bot.api.sendMessage(chatId, `Последнее успешное обновление: ${text}${updatedAt ? " МСК" : ""}.`);
  }

  private async stopSubscription(chatId: number): Promise<void> {
    await this.database.unsubscribe(this.id, String(chatId));
    await this.bot.api.sendMessage(chatId, "Автоматические уведомления отключены. Возобновить: /start");
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

  private async requestPersonalAnimation(
    kind: "satellite" | "clouds",
    recipientId: string,
    viewport: MapViewport,
  ): Promise<"queued" | "cached" | "unavailable"> {
    if (!this.personalAnimations) return "unavailable";
    try {
      return await this.personalAnimations.request(this.id, recipientId, kind, viewport);
    } catch (error) {
      this.logger.warn({ err: error, kind, recipientId }, "Personal animation request failed");
      return "unavailable";
    }
  }

  private async canForceUpdate(chatId: number): Promise<boolean> {
    const allowed = this.config.manualUpdate.telegramRecipientIds;
    if (allowed.length > 0) return allowed.includes(String(chatId));
    return this.database.claimManualUpdateOwner(this.id, String(chatId));
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

  private forecastKeyboard(): InlineKeyboard {
    const keyboard = new InlineKeyboard();
    for (const [index, point] of this.points.filter((item) => item.active).entries()) {
      keyboard.text(point.shortName, `forecast:${point.id}`);
      if (index % 2 === 1) keyboard.row();
    }
    return keyboard;
  }

  private bulletinKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🔬 Детали", "bulletin:details")
      .text("☁️ Облачность", "bulletin:clouds")
      .row()
      .text("🗺️ Прогноз погоды", "bulletin:forecast")
      .row()
      .text("▶️ Движение облаков", "bulletin:animation");
  }

  private helpKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("📍 Точки", "help:points")
      .text("🕒 Статус", "help:status")
      .row()
      .text("⏹ Отключить", "help:stop");
  }

  private startKeyboard(): InlineKeyboard {
    return new InlineKeyboard()
      .text("🌊 Бюллетень", "help:weather")
      .text("🗺️ Прогноз погоды", "help:forecast")
      .row()
      .text("📍 Точки", "help:points")
      .text("🕒 Статус", "help:status");
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

  private async sendContent(recipientId: string, content: string, replyMarkup?: InlineKeyboard) {
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
        ...(replyMarkup && index === chunks.length - 1 ? { reply_markup: replyMarkup } : {}),
      }));
    }
    return messages;
  }
}

function forecastPickerText(caption?: string): string {
  const mapCaption = caption ? `${escapeHtml(caption)}\n\n` : "";
  return `${mapCaption}<b>Прогноз погоды</b>\nВыберите контрольную точку, чтобы посмотреть прогноз на 5 дней.`;
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
