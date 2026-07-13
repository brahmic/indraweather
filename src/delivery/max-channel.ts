import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PublicationService } from "../application/publication-service.js";
import type { PersonalAnimationService } from "../application/personal-animation-service.js";
import type { AppConfig } from "../config.js";
import { escapeHtml } from "../domain/bulletin.js";
import {
  changeMapViewport,
  createMapViewport,
  formatMapExtent,
  type MapViewport,
  type MapViewportAction,
} from "../domain/map-viewport.js";
import type { ControlPoint } from "../domain/types.js";
import type { Database, MaxWebhookRecord } from "../infrastructure/database.js";
import type { MaxApiClient, MaxMessageAttachment } from "../infrastructure/max-api.js";
import type { Logger } from "../logger.js";
import { formatPostHtml, splitText } from "./post-format.js";
import { formatHelpHtml } from "./help-text.js";
import { formatPersonalCloudMotionStatus } from "./cloud-motion.js";
import type { DeliveryAttachment, DeliveryChannel, Publication } from "./types.js";

const userSchema = z.object({
  user_id: z.number(),
  is_bot: z.boolean().optional().default(false),
}).passthrough();

const messageSchema = z.object({
  sender: userSchema.nullable().optional(),
  recipient: z.object({
    chat_id: z.number().nullable(),
    chat_type: z.enum(["dialog", "chat", "channel"]),
  }),
  body: z.object({ mid: z.string(), text: z.string().nullable() }),
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
    message: messageSchema,
  }).passthrough(),
  z.object({
    update_type: z.literal("message_callback"),
    timestamp: z.number(),
    callback: z.object({
      timestamp: z.number(),
      callback_id: z.string().min(1),
      payload: z.string().optional(),
      user: userSchema,
    }),
    message: messageSchema.nullable().optional(),
  }).passthrough(),
]);

type MaxWebhookUpdate = z.infer<typeof updateSchema>;

interface MaxApi {
  initialize(webhookUrl: string, webhookSecret: string): Promise<string>;
  uploadImage(data: Uint8Array, filename: string): Promise<MaxMessageAttachment>;
  uploadVideo(data: Uint8Array, filename: string): Promise<MaxMessageAttachment>;
  sendMessage(
    userId: number,
    text: string,
    attachments?: MaxMessageAttachment[],
  ): Promise<string>;
  editMessage(messageId: string, text: string): Promise<void>;
  answerCallback(
    callbackId: string,
    message?: { text: string; attachments: MaxMessageAttachment[] },
    notification?: string,
  ): Promise<void>;
  deleteMessage(messageId: string): Promise<void>;
}

interface PreparedAttachment {
  kind: DeliveryAttachment["kind"];
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
    private readonly personalAnimations: PersonalAnimationService | null = null,
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
    if (update.update_type === "message_callback") {
      if (parseMapAction(update.callback.payload)) {
        await this.processMapCallback(update.callback.callback_id, update.callback.payload, update.callback.user.user_id);
      } else if (parseForecastDiagnosticAction(update.callback.payload)) {
        await this.processForecastDiagnosticCallback(
          update.callback.callback_id,
          update.callback.payload,
          update.callback.user.user_id,
        );
      } else if (parseBulletinAction(update.callback.payload)) {
        await this.processBulletinCallback(
          update.callback.callback_id,
          update.callback.payload,
          update.callback.user.user_id,
        );
      } else if (parseHelpAction(update.callback.payload)) {
        await this.processHelpCallback(
          update.callback.callback_id,
          update.callback.payload,
          update.callback.user.user_id,
        );
      } else {
        await this.processPointForecastCallback(
          update.callback.callback_id,
          update.callback.payload,
          update.callback.user.user_id,
        );
      }
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
        await this.stopSubscription(sender.user_id);
        break;
      case "help":
        await this.api.sendMessage(sender.user_id, formatHelpHtml(this.config.scheduleTimes), [this.helpKeyboard()]);
        break;
      case "weather":
        await this.sendWeather(sender.user_id);
        break;
      case "update":
        if (!await this.canForceUpdate(sender.user_id)) {
          this.logger.warn({ userId: sender.user_id }, "Unauthorized MAX manual update request");
          await this.api.sendMessage(sender.user_id, "Команда недоступна.");
          break;
        }
        await this.sendForcedUpdate(sender.user_id);
        break;
      case "details":
        await this.sendDetails(sender.user_id);
        break;
      case "animation":
        await this.sendCloudMotion(sender.user_id);
        break;
      case "forecast":
        await this.sendPointForecastPicker(sender.user_id);
        break;
      case "points":
        await this.sendPoints(sender.user_id);
        break;
      case "status":
        await this.sendStatus(sender.user_id);
        break;
      case "clouds":
        await this.sendClouds(sender.user_id);
        break;
      case "radar":
        await this.sendRadar(sender.user_id);
        break;
      case "lightning":
        await this.sendLightning(sender.user_id);
        break;
      case "map":
        await this.sendMap(sender.user_id);
        break;
    }
  }

  private async subscribeAndWelcome(userId: number): Promise<void> {
    await this.database.subscribe(this.id, String(userId));
    await this.api.sendMessage(userId, formatHelpHtml(this.config.scheduleTimes, true), [this.startKeyboard()]);
  }

  private async sendWeather(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Собираю прогноз и спутниковые снимки…");
    try {
      const map = await this.getMapSelection(userId);
      const publication = await this.publications.getFreshOrRun(map.viewport);
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

  private async sendForcedUpdate(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Принудительно обновляю бюллетень…");
    try {
      const map = await this.getMapSelection(userId);
      const publication = await this.publications.run({ kind: "manual" }, map.viewport);
      if (!publication) {
        await this.api.editMessage(progressId, "Сбор уже выполняется. Попробуйте через минуту.");
        return;
      }
      await this.sendPublication(userId, publication, this.prepareAttachments(publication));
      await this.api.deleteMessage(progressId).catch((error: unknown) => {
        this.logger.debug({ error }, "Failed to remove MAX manual update progress message");
      });
    } catch (error) {
      this.logger.error({ error }, "MAX manual update failed");
      await this.api.editMessage(
        progressId,
        "Не удалось обновить бюллетень: погодные данные временно недоступны.",
      ).catch(() => undefined);
    }
  }

  private async sendClouds(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Собираю информацию об облачности…");
    try {
      const map = await this.getMapSelection(userId);
      await this.sendDiagnostic(
        userId,
        () => this.publications.getClouds(map.viewport),
        "Диагностический снимок облаков временно недоступен.",
      );
    } catch (error) {
      this.logger.error({ error }, "MAX cloud diagnostic request failed");
      await this.api.sendMessage(userId, "Диагностический снимок облаков временно недоступен.");
    } finally {
      await this.api.deleteMessage(progressId).catch((error: unknown) =>
        this.logger.debug({ error }, "Failed to remove MAX clouds progress message"));
    }
  }

  private async sendLightning(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Получаю спутниковые данные о вспышках…");
    try {
      const map = await this.getMapSelection(userId);
      await this.sendDiagnostic(
        userId,
        async () => [await this.publications.getLightning(map.viewport)],
        "Данные о вспышках молний временно недоступны.",
      );
    } finally {
      await this.api.deleteMessage(progressId).catch((error: unknown) =>
        this.logger.debug({ error }, "Failed to remove MAX lightning progress message"));
    }
  }

  private async sendRadar(userId: number): Promise<void> {
    const map = await this.getMapSelection(userId);
    await this.sendDiagnostic(
      userId,
      async () => [await this.publications.getRadar(map.viewport)],
      "Радар Sentinel-1 временно недоступен или ещё не настроен.",
    );
  }

  private async sendDetails(userId: number): Promise<void> {
    try {
      const details = await this.publications.getFreshDetails();
      await this.sendText(userId, details.text);
    } catch (error) {
      this.logger.error({ error }, "MAX detailed model bulletin failed");
      await this.api.sendMessage(userId, "Не удалось сформировать детализацию: погодные данные временно недоступны.");
    }
  }

  private async sendCloudMotion(userId: number): Promise<void> {
    const progressId = await this.api.sendMessage(userId, "⏳ Готовлю анимацию движения облаков…");
    try {
      const map = await this.getMapSelection(userId);
      if (map.isCustom) {
        const results = await Promise.all([
          this.requestPersonalAnimation("satellite", userId, map.viewport),
          this.requestPersonalAnimation("clouds", userId, map.viewport),
        ]);
        await this.api.editMessage(progressId, formatPersonalCloudMotionStatus(results));
        return;
      }
      for (const attachment of await this.publications.getCloudMotionAnimations()) {
        await this.sendAttachment(userId, attachment);
      }
      await this.api.deleteMessage(progressId).catch((error: unknown) =>
        this.logger.debug({ error }, "Failed to remove MAX cloud motion progress message"));
    } catch (error) {
      this.logger.error({ error }, "MAX cloud motion request failed");
      await this.api.editMessage(
        progressId,
        "Анимации пока недоступны: недостаточно кадров или источник временно не отвечает.",
      ).catch(() => undefined);
    }
  }

  private async sendMap(userId: number): Promise<void> {
    try {
      const viewport = (await this.getMapSelection(userId)).viewport;
      const image = await this.publications.getMap(viewport);
      const uploaded = await this.api.uploadImage(image.data, image.filename);
      await this.api.sendMessage(userId, this.mapCaption(image.caption, viewport), [
        uploaded,
        this.mapKeyboard(),
      ]);
    } catch (error) {
      this.logger.warn({ err: error, userId }, "MAX map request failed");
      await this.api.sendMessage(userId, "Карту сейчас получить не удалось. Попробуйте ещё раз через минуту.");
    }
  }

  private async sendPointForecastPicker(userId: number): Promise<void> {
    try {
      const image = await this.publications.getForecastMap(
        (await this.getMapSelection(userId)).viewport,
      );
      const uploaded = await this.api.uploadImage(image.data, image.filename);
      await this.api.sendMessage(userId, formatPostHtml(image.caption, [], true), [
        uploaded,
        this.forecastDiagnosticKeyboard(),
      ]);
    } catch (error) {
      this.logger.warn({ err: error, userId }, "MAX forecast map request failed");
      await this.api.sendMessage(userId, "Модельную карту сейчас получить не удалось. Попробуйте ещё раз через минуту.");
    }
    await this.api.sendMessage(userId, forecastPickerText(), [this.forecastKeyboard()]);
  }

  private async processPointForecastCallback(
    callbackId: string,
    payload: string | undefined,
    userId: number,
  ): Promise<void> {
    const pointId = parsePointForecastId(payload);
    const point = pointId
      ? this.points.find((item) => item.id === pointId && item.active)
      : undefined;
    if (!point) {
      await this.api.answerCallback(callbackId, undefined, "Точка больше не активна.");
      return;
    }
    await this.api.answerCallback(callbackId, {
      text: `⏳ Готовлю прогноз для ${point.shortName}…`,
      attachments: [],
    });
    try {
      const content = await this.publications.getPointForecast(point.id);
      await this.api.sendMessage(userId, formatPostHtml(content, this.points.map((item) => item.name), true));
    } catch (error) {
      this.logger.error({ error, pointId }, "MAX point forecast request failed");
      await this.api.sendMessage(userId, "Не удалось подготовить пятидневный прогноз. Попробуйте ещё раз через минуту.");
    }
  }

  private async processBulletinCallback(
    callbackId: string,
    payload: string | undefined,
    userId: number,
  ): Promise<void> {
    const action = parseBulletinAction(payload);
    if (!action) {
      await this.api.answerCallback(callbackId, undefined, "Кнопка больше не актуальна.");
      return;
    }
    if (action === "forecast") {
      await this.api.answerCallback(callbackId, undefined, "⏳ Готовлю модельную карту…");
      await this.sendPointForecastPicker(userId);
      return;
    }
    const title = action === "details"
      ? "⏳ Готовлю детализацию по моделям…"
      : action === "animation"
      ? "⏳ Готовлю анимацию движения облаков…"
      : "⏳ Собираю информацию об облачности…";
    await this.api.answerCallback(callbackId, { text: title, attachments: [] });
    if (action === "details") await this.sendDetails(userId);
    else if (action === "animation") await this.sendCloudMotion(userId);
    else await this.sendClouds(userId);
  }

  private async processHelpCallback(
    callbackId: string,
    payload: string | undefined,
    userId: number,
  ): Promise<void> {
    const action = parseHelpAction(payload);
    if (!action) {
      await this.api.answerCallback(callbackId, undefined, "Кнопка больше не актуальна.");
      return;
    }
    if (action === "forecast") {
      await this.api.answerCallback(callbackId, undefined, "⏳ Готовлю модельную карту…");
      await this.sendPointForecastPicker(userId);
      return;
    }
    const title = action === "weather"
      ? "⏳ Запрашиваю бюллетень…"
      : action === "points"
      ? "⏳ Загружаю контрольные точки…"
      : action === "status"
      ? "⏳ Проверяю статус обновления…"
      : "⏳ Отключаю автоматические уведомления…";
    await this.api.answerCallback(callbackId, { text: title, attachments: [] });
    if (action === "points") await this.sendPoints(userId);
    else if (action === "status") await this.sendStatus(userId);
    else if (action === "stop") await this.stopSubscription(userId);
    else await this.sendWeather(userId);
  }

  private async processForecastDiagnosticCallback(
    callbackId: string,
    payload: string | undefined,
    userId: number,
  ): Promise<void> {
    const action = parseForecastDiagnosticAction(payload);
    if (!action) {
      await this.api.answerCallback(callbackId, undefined, "Кнопка больше не актуальна.");
      return;
    }
    const title = action === "clouds"
      ? "⏳ Собираю информацию об облачности…"
      : action === "animation"
      ? "⏳ Готовлю анимацию движения облаков…"
      : action === "lightning"
      ? "⏳ Получаю данные о вспышках…"
      : "⏳ Запрашиваю радар Sentinel-1…";
    await this.api.answerCallback(callbackId, undefined, title);
    if (action === "clouds") await this.sendClouds(userId);
    else if (action === "animation") await this.sendCloudMotion(userId);
    else if (action === "lightning") await this.sendLightning(userId);
    else await this.sendRadar(userId);
  }

  private async processMapCallback(
    callbackId: string,
    payload: string | undefined,
    userId: number,
  ): Promise<void> {
    const action = parseMapAction(payload);
    if (!action) {
      await this.api.answerCallback(callbackId, undefined, "Кнопка больше не актуальна.");
      return;
    }
    try {
      const current = (await this.getMapSelection(userId)).viewport;
      const viewport = action === "refresh"
        ? current
        : changeMapViewport(current, action);
      if (action !== "refresh") {
        await this.database.saveMapViewport(this.id, String(userId), viewport.bbox);
      }
      const image = await this.publications.getMap(viewport);
      const uploaded = await this.api.uploadImage(image.data, image.filename);
      await this.api.answerCallback(callbackId, {
        text: this.mapCaption(image.caption, viewport),
        attachments: [uploaded, this.mapKeyboard()],
      });
    } catch (error) {
      this.logger.warn({ err: error, userId, payload }, "MAX map update failed");
      await this.api.answerCallback(
        callbackId,
        undefined,
        "Карту сейчас обновить не удалось. Попробуйте ещё раз через минуту.",
      ).catch((answerError: unknown) =>
        this.logger.warn({ err: answerError, userId }, "MAX map failure callback could not be answered"));
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

  private async stopSubscription(userId: number): Promise<void> {
    await this.database.unsubscribe(this.id, String(userId));
    await this.api.sendMessage(userId, "Автоматические уведомления отключены. Возобновить: /start");
  }

  private async getMapSelection(userId: number): Promise<{ viewport: MapViewport; isCustom: boolean }> {
    const saved = await this.database.getMapViewport(this.id, String(userId));
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
    userId: number,
    viewport: MapViewport,
  ): Promise<"queued" | "cached" | "unavailable"> {
    if (!this.personalAnimations) return "unavailable";
    try {
      return await this.personalAnimations.request(this.id, String(userId), kind, viewport);
    } catch (error) {
      this.logger.warn({ err: error, kind, userId }, "MAX personal animation request failed");
      return "unavailable";
    }
  }

  private async canForceUpdate(userId: number): Promise<boolean> {
    const allowed = this.config.manualUpdate.maxRecipientIds;
    if (allowed.length > 0) return allowed.includes(String(userId));
    return this.database.claimManualUpdateOwner(this.id, String(userId));
  }

  private mapKeyboard(): MaxMessageAttachment {
    return {
      type: "inline_keyboard",
      payload: {
        buttons: [
          [{ type: "callback", text: "↑", payload: "map:up" }],
          [
            { type: "callback", text: "←", payload: "map:left" },
            { type: "callback", text: "⟳", payload: "map:refresh" },
            { type: "callback", text: "→", payload: "map:right" },
          ],
          [{ type: "callback", text: "↓", payload: "map:down" }],
          [
            { type: "callback", text: "−", payload: "map:zoom-out" },
            { type: "callback", text: "+", payload: "map:zoom-in" },
          ],
        ],
      },
    };
  }

  private forecastKeyboard(): MaxMessageAttachment {
    const points = this.points.filter((point) => point.active);
    return {
      type: "inline_keyboard",
      payload: {
        buttons: Array.from({ length: Math.ceil(points.length / 2) }, (_, row) =>
          points.slice(row * 2, row * 2 + 2).map((point) => ({
            type: "callback" as const,
            text: point.shortName,
            payload: `forecast:${point.id}`,
          })),
        ),
      },
    };
  }

  private forecastDiagnosticKeyboard(): MaxMessageAttachment {
    return {
      type: "inline_keyboard",
      payload: {
        buttons: [[
          { type: "callback", text: "☁️ Облачность", payload: "forecast-action:clouds" },
          { type: "callback", text: "▶️ Движение облаков", payload: "forecast-action:animation" },
        ], [
          { type: "callback", text: "⚡ Грозовая активность", payload: "forecast-action:lightning" },
          { type: "callback", text: "📡 Радар", payload: "forecast-action:radar" },
        ]],
      },
    };
  }

  private bulletinKeyboard(): MaxMessageAttachment {
    return {
      type: "inline_keyboard",
      payload: {
        buttons: [[
          { type: "callback", text: "🔬 Детали", payload: "bulletin:details" },
          { type: "callback", text: "☁️ Облачность", payload: "bulletin:clouds" },
        ], [
          { type: "callback", text: "🗺️ Прогноз погоды", payload: "bulletin:forecast" },
        ], [
          { type: "callback", text: "▶️ Движение облаков", payload: "bulletin:animation" },
        ]],
      },
    };
  }

  private helpKeyboard(): MaxMessageAttachment {
    return {
      type: "inline_keyboard",
      payload: {
        buttons: [
          [
            { type: "callback", text: "📍 Точки", payload: "help:points" },
            { type: "callback", text: "🕒 Статус", payload: "help:status" },
          ],
          [{ type: "callback", text: "⏹ Отключить", payload: "help:stop" }],
        ],
      },
    };
  }

  private startKeyboard(): MaxMessageAttachment {
    return {
      type: "inline_keyboard",
      payload: {
        buttons: [
          [
            { type: "callback", text: "🌊 Бюллетень", payload: "help:weather" },
            { type: "callback", text: "🗺️ Прогноз погоды", payload: "help:forecast" },
          ],
          [
            { type: "callback", text: "📍 Точки", payload: "help:points" },
            { type: "callback", text: "🕒 Статус", payload: "help:status" },
          ],
        ],
      },
    };
  }

  private mapCaption(caption: string, viewport: MapViewport): string {
    return formatPostHtml(`${caption}\n${formatMapExtent(viewport)}`, [], true);
  }

  private async sendDiagnostic(
    userId: number,
    getAttachments: () => Promise<DeliveryAttachment[]>,
    failure: string,
  ): Promise<boolean> {
    let attachments: DeliveryAttachment[];
    try {
      attachments = await getAttachments();
    } catch (error) {
      this.logger.warn({ err: error }, "MAX satellite diagnostic request failed");
      await this.api.sendMessage(userId, failure);
      return false;
    }
    let sent = false;
    for (const attachment of attachments) {
      try {
        await this.sendAttachment(userId, attachment);
        sent = true;
      } catch (error) {
        this.logger.warn({ err: error, filename: attachment.filename }, "MAX diagnostic delivery failed");
      }
    }
    if (!sent) {
      await this.api.sendMessage(userId, "Снимок собран, но MAX временно не принял файл. Повторите запрос позже.");
    }
    return sent;
  }

  private async prepareAttachments(publication: Publication): Promise<PreparedAttachment[]> {
    const attachments: PreparedAttachment[] = [];
    for (const attachment of publication.attachments) {
      try {
        const uploaded = attachment.kind === "image"
          ? await this.api.uploadImage(attachment.data, attachment.filename)
          : await this.api.uploadVideo(attachment.data, attachment.filename);
        attachments.push({
          kind: attachment.kind,
          caption: attachment.caption,
          attachment: uploaded,
        });
      } catch (error) {
        this.logger.warn(
          { err: error, kind: attachment.kind, filename: attachment.filename },
          "MAX attachment upload failed",
        );
      }
    }
    return attachments;
  }

  private async sendAttachment(userId: number, attachment: DeliveryAttachment): Promise<string> {
    const uploaded = attachment.kind === "image"
      ? await this.api.uploadImage(attachment.data, attachment.filename)
      : await this.api.uploadVideo(attachment.data, attachment.filename);
    return this.api.sendMessage(userId, formatPostHtml(attachment.caption, [], true), [uploaded]);
  }

  async sendPersonalAnimation(recipientId: string, attachment: DeliveryAttachment): Promise<void> {
    await this.sendAttachment(parseRecipientId(recipientId), attachment);
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
    const attachments = await prepared;
    const images = attachments.filter((item) => item.kind === "image");
    if (images.length >= 2) {
      messageIds.push(await this.api.sendMessage(
        userId,
        "<b>Спутниковые снимки и прогноз</b>",
        images.map((item) => item.attachment),
      ));
    } else {
      for (const item of images) {
        messageIds.push(await this.api.sendMessage(
          userId,
          formatPostHtml(item.caption, [], true),
          [item.attachment],
        ));
      }
    }
    for (const item of attachments.filter((attachment) => attachment.kind !== "image")) {
      messageIds.push(await this.api.sendMessage(
        userId,
        formatPostHtml(item.caption, [], true),
        [item.attachment],
      ));
    }
    messageIds.push(...await this.sendText(userId, publication.text, this.bulletinKeyboard()));
    return messageIds;
  }

  private async sendText(
    userId: number,
    content: string,
    replyMarkup?: MaxMessageAttachment,
  ): Promise<string[]> {
    const chunks = splitText(content, 3400);
    const messageIds: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const text = formatPostHtml(chunk, this.points.map((point) => point.name), index === 0);
      if (replyMarkup && index === chunks.length - 1) {
        messageIds.push(await this.api.sendMessage(userId, text, [replyMarkup]));
      } else {
        messageIds.push(await this.api.sendMessage(userId, text));
      }
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

function parseMapAction(payload: string | undefined): MapViewportAction | null {
  switch (payload) {
    case "map:up":
      return "up";
    case "map:down":
      return "down";
    case "map:left":
      return "left";
    case "map:right":
      return "right";
    case "map:zoom-in":
      return "zoom-in";
    case "map:zoom-out":
      return "zoom-out";
    case "map:refresh":
      return "refresh";
    default:
      return null;
  }
}

function parsePointForecastId(payload: string | undefined): string | null {
  const match = /^forecast:([a-z0-9-]+)$/u.exec(payload ?? "");
  return match?.[1] ?? null;
}

function forecastPickerText(): string {
  return "<b>Прогноз погоды</b>\nВыберите контрольную точку, чтобы посмотреть прогноз на 5 дней.";
}

function parseForecastDiagnosticAction(
  payload: string | undefined,
): "clouds" | "animation" | "lightning" | "radar" | null {
  switch (payload) {
    case "forecast-action:clouds":
      return "clouds";
    case "forecast-action:animation":
      return "animation";
    case "forecast-action:lightning":
      return "lightning";
    case "forecast-action:radar":
      return "radar";
    default:
      return null;
  }
}

function parseBulletinAction(payload: string | undefined): "details" | "clouds" | "forecast" | "animation" | null {
  return payload === "bulletin:details" || payload === "bulletin:clouds" || payload === "bulletin:forecast"
    || payload === "bulletin:animation"
    ? payload.slice("bulletin:".length) as "details" | "clouds" | "forecast" | "animation"
    : null;
}

function parseHelpAction(payload: string | undefined): "points" | "status" | "stop" | "weather" | "forecast" | null {
  return payload === "help:points" || payload === "help:status" || payload === "help:stop"
    || payload === "help:weather" || payload === "help:forecast"
    ? payload.slice("help:".length) as "points" | "status" | "stop" | "weather" | "forecast"
    : null;
}

function parseRecipientId(value: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`Invalid MAX user id: ${value}`);
  return result;
}
