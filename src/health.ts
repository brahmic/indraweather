import { createServer, type Server } from "node:http";
import type { Database } from "./infrastructure/database.js";
import type { Logger } from "./logger.js";

export function startHealthServer(database: Database, port: number, logger: Logger): Server {
  const server = createServer(async (request, response) => {
    if (request.url === "/health/live") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"status":"ok"}');
      return;
    }
    if (request.url === "/health/ready") {
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
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not_found"}');
  });
  server.listen(port, "0.0.0.0", () => logger.info({ port }, "Health server listening"));
  return server;
}
