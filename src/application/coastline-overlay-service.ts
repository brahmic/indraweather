import sharp from "sharp";
import type { MapViewport } from "../domain/map-viewport.js";
import type { ControlPoint } from "../domain/types.js";
import type { CoastlinePath } from "../infrastructure/eumetview.js";

export interface CoastlineOverlayOptions {
  bbox: [number, number, number, number];
  width: number;
  height: number;
  maxImageBytes: number;
  points: readonly ControlPoint[];
}

export class CoastlineOverlayService {
  constructor(private readonly options: CoastlineOverlayOptions) {}

  withViewport(viewport: MapViewport): CoastlineOverlayService {
    return new CoastlineOverlayService({
      ...this.options,
      bbox: viewport.bbox,
      width: viewport.width,
      height: viewport.height,
    });
  }

  async apply(
    image: Uint8Array,
    coastline: CoastlinePath[],
    { includeMapContext = true }: { includeMapContext?: boolean } = {},
  ): Promise<Uint8Array> {
    const pathData = coastline
      .map((line) => this.toSvgPath(line))
      .filter(Boolean)
      .join(" ");
    if (!pathData) throw new Error("Coastline geometry is empty");

    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg"
           width="${this.options.width}" height="${this.options.height}"
           viewBox="0 0 ${this.options.width} ${this.options.height}">
        <path d="${pathData}" fill="none" stroke="#ffffff" stroke-opacity="0.9"
              stroke-width="5" stroke-linejoin="round" stroke-linecap="round" />
        <path d="${pathData}" fill="none" stroke="#17242b" stroke-opacity="0.95"
              stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round" />
      </svg>
    `;
    const coastlined = await this.composite(image, svg);
    return includeMapContext ? this.applyContext(coastlined) : coastlined;
  }

  async applyContext(image: Uint8Array): Promise<Uint8Array> {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg"
           width="${this.options.width}" height="${this.options.height}"
           viewBox="0 0 ${this.options.width} ${this.options.height}">
        ${this.renderSettlements()}
        ${this.renderNorthArrow()}
        ${this.renderScale()}
      </svg>
    `;
    return this.composite(image, svg);
  }

  private async composite(image: Uint8Array, svg: string): Promise<Uint8Array> {
    const result = await sharp(image)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer();
    if (result.byteLength > this.options.maxImageBytes) {
      throw new Error(`Satellite image with coastline exceeds ${this.options.maxImageBytes} bytes`);
    }
    return new Uint8Array(result);
  }

  private toSvgPath(line: CoastlinePath): string {
    return line.map(([longitude, latitude], index) => {
      const [x, y] = this.project(longitude, latitude);
      return `${index === 0 ? "M" : "L"}${round(x)},${round(y)}`;
    }).join(" ");
  }

  private project(longitude: number, latitude: number): [number, number] {
    const [west, south, east, north] = this.options.bbox;
    return [
      (longitude - west) / (east - west) * this.options.width,
      (north - latitude) / (north - south) * this.options.height,
    ];
  }

  private renderSettlements(): string {
    const [west, south, east, north] = this.options.bbox;
    return this.options.points.filter((place) => place.active &&
      place.longitude >= west && place.longitude <= east && place.latitude >= south && place.latitude <= north)
      .map((place) => {
        const [x, y] = this.project(place.longitude, place.latitude);
        const anchor = x > this.options.width * 0.72 ? "end" : "start";
        const textX = x > this.options.width * 0.72 ? x - 8 : x + 8;
        const textY = y < 26 ? y + 16 : y - 8;
        return `<g>
          <circle cx="${round(x)}" cy="${round(y)}" r="4" fill="#ffd54f" stroke="#17242b" stroke-width="1.5" />
          <text x="${round(textX)}" y="${round(textY)}" text-anchor="${anchor}"
                fill="#ffffff" stroke="#17242b" stroke-width="3" paint-order="stroke"
                font-family="Noto Sans, sans-serif" font-size="16" font-weight="600">${place.shortName}</text>
        </g>`;
      }).join("\n");
  }

  private renderNorthArrow(): string {
    const x = this.options.width - 34;
    return `<g transform="translate(${x} 20)">
      <text x="0" y="0" text-anchor="middle" fill="#ffffff" stroke="#17242b" stroke-width="2.5"
            paint-order="stroke" font-family="Noto Sans, sans-serif" font-size="18" font-weight="700">С</text>
      <path d="M0 7 L-7 25 L0 20 L7 25 Z" fill="#ffffff" stroke="#17242b" stroke-width="1.5" />
    </g>`;
  }

  private renderScale(): string {
    const [west, south, east, north] = this.options.bbox;
    const latitude = (south + north) / 2 * Math.PI / 180;
    const widthKm = (east - west) * 111.32 * Math.cos(latitude);
    const kilometres = [5, 10, 20, 25, 50].findLast((value) => value <= widthKm * 0.25) ?? 5;
    const pixels = kilometres / widthKm * this.options.width;
    const x = this.options.width - pixels - 26;
    const y = this.options.height - 28;
    return `<g>
      <path d="M${round(x)} ${round(y)} H${round(x + pixels)} M${round(x)} ${round(y - 5)} V${round(y + 5)} M${round(x + pixels)} ${round(y - 5)} V${round(y + 5)}"
            fill="none" stroke="#ffffff" stroke-width="3" stroke-linecap="square" />
      <path d="M${round(x)} ${round(y)} H${round(x + pixels)} M${round(x)} ${round(y - 5)} V${round(y + 5)} M${round(x + pixels)} ${round(y - 5)} V${round(y + 5)}"
            fill="none" stroke="#17242b" stroke-width="1" stroke-linecap="square" />
      <text x="${round(x + pixels / 2)}" y="${round(y - 9)}" text-anchor="middle" fill="#ffffff"
            stroke="#17242b" stroke-width="2.5" paint-order="stroke"
            font-family="Noto Sans, sans-serif" font-size="15" font-weight="600">${kilometres} км</text>
    </g>`;
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
