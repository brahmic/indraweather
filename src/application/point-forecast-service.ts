import type { AppConfig } from "../config.js";
import {
  POINT_FORECAST_HOURS,
  renderPointForecast,
} from "../domain/point-forecast.js";
import type { ControlPoint } from "../domain/types.js";
import type { Database } from "../infrastructure/database.js";
import type { BulletinService } from "./bulletin-service.js";

export class PointForecastService {
  constructor(
    private readonly database: Database,
    private readonly bulletins: BulletinService,
    private readonly points: ControlPoint[],
    private readonly config: AppConfig,
  ) {}

  async get(pointId: string): Promise<string> {
    const point = this.points.find((item) => item.id === pointId && item.active);
    if (!point) throw new Error(`Unknown control point: ${pointId}`);
    const bulletin = await this.bulletins.getFreshOrRun(POINT_FORECAST_HOURS, point.id);
    const [weather, marine] = await Promise.all([
      this.database.getForecastValues(bulletin.runId, point.id),
      this.database.getMarineForecastValues(bulletin.runId, point.id),
    ]);
    return renderPointForecast({
      point,
      generatedAt: bulletin.createdAt,
      weather,
      marine,
      timeZone: this.config.timeZone,
    });
  }
}
