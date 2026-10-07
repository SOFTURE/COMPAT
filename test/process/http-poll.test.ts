import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findFreePort } from "../../src/process/background-process.js";
import { pollUrl } from "../../src/process/http-poll.js";

let server: Server;
let baseUrl: string;
let warmupRequests = 0;
let stallingRequests = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === "/secret") {
      const isAuthorized = request.headers["x-key"] === "k1";
      response.writeHead(isAuthorized ? 200 : 401);
      response.end(isAuthorized ? "secret" : "");
      return;
    }
    if (request.url === "/warmup") {
      warmupRequests += 1;
      response.writeHead(200);
      response.end(warmupRequests < 3 ? "<html>starting</html>" : '{"openapi":"3.0.3"}');
      return;
    }
    if (request.url === "/stalls-after-first") {
      stallingRequests += 1;
      if (stallingRequests > 1) return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

const soon = (ms: number) => Date.now() + ms;

describe("pollUrl", () => {
  it("sends the headers and returns the body of a 2xx answer", async () => {
    expect(
      await pollUrl({ url: `${baseUrl}/secret`, headers: { "x-key": "k1" }, deadline: soon(2_000) }),
    ).toEqual({
      status: "ready",
      body: "secret",
    });
  });

  it("names the last HTTP status when the deadline passes", async () => {
    expect(await pollUrl({ url: `${baseUrl}/secret`, deadline: soon(300), intervalMs: 50 })).toEqual({
      status: "timed-out",
      lastObservation: "HTTP 401",
    });
  });

  it("keeps the last answer when the deadline cuts the final request short", async () => {
    expect(
      await pollUrl({ url: `${baseUrl}/stalls-after-first`, deadline: soon(300), intervalMs: 50 }),
    ).toEqual({
      status: "timed-out",
      lastObservation: "HTTP 404",
    });
  });

  it("names a refused connection", async () => {
    const port = await findFreePort();
    if (!port.ok) throw new Error(port.error);
    expect(
      await pollUrl({ url: `http://127.0.0.1:${port.value}/`, deadline: soon(300), intervalMs: 50 }),
    ).toEqual({
      status: "timed-out",
      lastObservation: "connection refused",
    });
  });

  it("keeps polling until the body is accepted", async () => {
    const outcome = await pollUrl({
      url: `${baseUrl}/warmup`,
      deadline: soon(5_000),
      intervalMs: 20,
      accept: (body) => body.startsWith("{"),
    });
    expect(outcome).toEqual({ status: "ready", body: '{"openapi":"3.0.3"}' });
    expect(warmupRequests).toBe(3);
  });

  it("stops early with the reason and the last observation", async () => {
    let attempts = 0;
    const outcome = await pollUrl({
      url: `${baseUrl}/secret`,
      deadline: soon(5_000),
      intervalMs: 20,
      getStopReason: () => (attempts++ >= 2 ? "app exited 1" : null),
    });
    expect(outcome).toEqual({ status: "stopped", reason: "app exited 1", lastObservation: "HTTP 401" });
  });
});
