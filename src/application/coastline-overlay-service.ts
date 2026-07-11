import sharp from "sharp";
import type { CoastlinePath } from "../infrastructure/eumetview.js";

export interface CoastlineOverlayOptions {
  bbox: [number, number, number, number];
  width: number;
  height: number;
  maxImageBytes: number;
}

export class CoastlineOverlayService {
  constructor(private readonly options: CoastlineOverlayOptions) {}

  async apply(image: Uint8Array, coastline: CoastlinePath[]): Promise<Uint8Array> {
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
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
