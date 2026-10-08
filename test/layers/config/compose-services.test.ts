// biome-ignore-all lint/suspicious/noTemplateCurlyInString: Compose interpolation syntax is the test input
import { describe, expect, it } from "vitest";
import { readServiceEnvironment } from "../../../src/layers/config/compose-services.js";

const COMPOSE = [
  "services:",
  "  api:",
  "    image: api",
  "    environment:",
  "      - Stripe__SecretKey=${STRIPE_SECRET_KEY}",
  '      - "Shop__ApiKey=${SHOP_API_KEY}"',
  "      - PASS_THROUGH",
  "    ports: ['80']",
  "  worker:",
  "    environment:",
  "      # Stripe__SecretKey: commented out",
  "      Stripe__WebhookSecret: ${STRIPE_WEBHOOK_SECRET}",
  "      Nested:",
  "        Deeper: x",
  "  flow:",
  "    environment: [A=1, B]",
  "  bare:",
  "    image: bare",
  "",
].join("\n");

describe("readServiceEnvironment", () => {
  it("reads sequence entries of one service with their lines", () => {
    expect(readServiceEnvironment(COMPOSE, "api")).toEqual([
      { key: "Stripe__SecretKey", line: 5 },
      { key: "Shop__ApiKey", line: 6 },
      { key: "PASS_THROUGH", line: 7 },
    ]);
  });

  it("reads mapping entries and skips comments", () => {
    expect(readServiceEnvironment(COMPOSE, "worker")).toEqual([
      { key: "Stripe__WebhookSecret", line: 12 },
      { key: "Nested", line: 13 },
    ]);
  });

  it("reads a one-line flow list", () => {
    expect(readServiceEnvironment(COMPOSE, "flow")).toEqual([
      { key: "A", line: 16 },
      { key: "B", line: 16 },
    ]);
  });

  it("gives no keys for a service without environment and null for a missing service", () => {
    expect(readServiceEnvironment(COMPOSE, "bare")).toEqual([]);
    expect(readServiceEnvironment(COMPOSE, "image")).toBeNull();
    expect(readServiceEnvironment("version: '3'\n", "api")).toBeNull();
  });
});
