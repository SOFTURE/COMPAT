#!/usr/bin/env node
// A test app that serves its OpenAPI spec only while it runs, like an ASP.NET app with Swashbuckle.
// It reads APP_SPEC (default api/spec.json) from its working directory (the materialized ref) and listens on APP_PORT.
// APP_API_KEY: the spec needs an X-Internal-Api-Key header with this value, otherwise 401.
// APP_IGNORE_TERM=1: SIGTERM is ignored. APP_PID_FILE: the process id is written there.
// APP_START_DELAY_MS: how long the app "boots" before it listens. APP_EXIT_CODE: exit at once with it.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.env.APP_EXIT_CODE) {
  console.error("startup failed: missing connection string");
  process.exit(Number(process.env.APP_EXIT_CODE));
}
if (process.env.APP_IGNORE_TERM === "1") process.on("SIGTERM", () => {});
if (process.env.APP_PID_FILE) writeFileSync(process.env.APP_PID_FILE, String(process.pid));
const port = Number(process.env.APP_PORT);
const spec = readFileSync(process.env.APP_SPEC ?? "api/spec.json", "utf8");
const key = process.env.APP_API_KEY;
const server = createServer((request, response) => {
  if (request.url === "/hc") {
    response.writeHead(200);
    response.end("Healthy");
    return;
  }
  if (request.url === "/swagger/v1/swagger.json") {
    if (key && request.headers["x-internal-api-key"] !== key) {
      response.writeHead(401);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(spec);
    return;
  }
  response.writeHead(404);
  response.end();
});
setTimeout(
  () => {
    server.listen(port, "127.0.0.1", () => console.log(`listening on ${port}`));
  },
  Number(process.env.APP_START_DELAY_MS ?? 0),
);
