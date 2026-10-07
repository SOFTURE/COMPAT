// A tiny API for the behaviour layer tests. It listens on COMPAT_PORT and answers GET /pets/count
// with the body of pets-count.json next to it, so base and revision differ only in that file.
// APP_PID_FILE: the process id is written there.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";

if (process.env.APP_PID_FILE) writeFileSync(process.env.APP_PID_FILE, String(process.pid));
const body = readFileSync(new URL("./pets-count.json", import.meta.url), "utf8");
const server = createServer((request, response) => {
  if (request.url === "/hc") {
    response.writeHead(200);
    response.end("Healthy");
    return;
  }
  if (request.url === "/pets/count") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(body);
    return;
  }
  response.writeHead(404);
  response.end();
});
server.listen(Number(process.env.COMPAT_PORT), "127.0.0.1");
