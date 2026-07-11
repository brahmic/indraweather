export interface ImageAttachment {
  kind: "image";
  data: Uint8Array;
  contentType: "image/png" | "image/jpeg";
  filename: string;
  caption: string;
  source: string;
  observedAt: Date;
}

export type DeliveryAttachment = ImageAttachment;

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
