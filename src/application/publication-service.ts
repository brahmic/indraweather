import type { BulletinService, RunBulletinOptions } from "./bulletin-service.js";
import type { Publication } from "../delivery/types.js";
import type { SatelliteImageService } from "./satellite-image-service.js";
import type { BulletinRecord } from "../infrastructure/database.js";
import type { Logger } from "../logger.js";

export class PublicationService {
  constructor(
    private readonly bulletins: BulletinService,
    private readonly satellite: SatelliteImageService | null,
    private readonly logger: Logger,
  ) {}

  async getFreshOrRun(): Promise<Publication> {
    return this.create(await this.bulletins.getFreshOrRun());
  }

  async run(options: RunBulletinOptions): Promise<Publication | null> {
    const bulletin = await this.bulletins.run(options);
    return bulletin ? this.create(bulletin) : null;
  }

  private async create(bulletin: BulletinRecord): Promise<Publication> {
    const attachments = [];
    if (this.satellite) {
      try {
        attachments.push(await this.satellite.getLatest());
      } catch (error) {
        this.logger.warn({ error, bulletinId: bulletin.id }, "Satellite image is unavailable");
      }
    }
    return {
      id: bulletin.id,
      text: bulletin.content,
      attachments,
    };
  }
}
