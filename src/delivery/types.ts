export interface ImageAttachment {
  kind: "image";
  data: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  filename: string;
  caption: string;
  source: string;
  observedAt: Date;
}

export interface AnimationAttachment {
  kind: "animation";
  data: Uint8Array;
  contentType: "video/mp4";
  filename: string;
  caption: string;
  source: string;
  startedAt: Date;
  endedAt: Date;
  frameCount: number;
}

export type DeliveryAttachment = ImageAttachment | AnimationAttachment;

export interface Publication {
  id: string;
  text: string;
  attachments: DeliveryAttachment[];
}

export interface DeliveryChannel {
  readonly id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(publication: Publication): Promise<void>;
}
