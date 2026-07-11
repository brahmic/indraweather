import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Database } from "./infrastructure/database.js";
import type { Logger } from "./logger.js";

export interface MaxWebhookReceiver {
  readonly webhookPath: string;
  acceptWebhook(secret: string | undefined, rawBody: string): Promise<
    "accepted" | "unauthorized" | "invalid"
  >;
}

export function startHealthServer(
  database: Database,
  port: number,
  logger: Logger,
  maxWebhook: MaxWebhookReceiver | null = null,
): Server {
  const server = createServer((request, response) => {
    void handleRequest(request, response, database, maxWebhook).catch((error: unknown) => {
      logger.error({ error }, "HTTP request failed");
      if (!response.headersSent) response.writeHead(500, { "content-type": "application/json" });
      response.end('{"error":"internal_error"}');
    });
  });
  server.listen(port, "0.0.0.0", () => logger.info({ port }, "Health server listening"));
  return server;
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  database: Database,
  maxWebhook: MaxWebhookReceiver | null,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method === "GET") {
    if (pathname === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (pathname === "/health/ready") {
      try {
        await database.ping();
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ready"}');
      } catch {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"status":"not_ready"}');
      }
      return;
    }
  }
  if (request.method === "POST" && maxWebhook && pathname === maxWebhook.webhookPath) {
    const secretHeader = request.headers["x-max-bot-api-secret"];
    const secret = Array.isArray(secretHeader) ? secretHeader[0] : secretHeader;
    const result = await maxWebhook.acceptWebhook(secret, await readBody(request, 1_000_000));
    const status = result === "accepted" ? 200 : result === "unauthorized" ? 401 : 400;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(result === "accepted" ? '{"status":"accepted"}' : `{"error":"${result}"}`);
    return;
  }
  response.writeHead(404, { "content-type": "application/json" });
  response.end('{"error":"not_found"}');
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
