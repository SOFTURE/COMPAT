import { behaviourLayer } from "./behaviour/behaviour-layer.js";
import { clientUsageLayer } from "./client-usage/client-usage-layer.js";
import { configLayer } from "./config/config-layer.js";
import { dependenciesLayer } from "./dependencies/dependencies-layer.js";
import { errorCodesLayer } from "./error-codes/error-codes-layer.js";
import type { Layer } from "./layer.js";
import { messageContractsLayer } from "./message-contracts/message-contracts-layer.js";
import { openapiLayer } from "./openapi/openapi-layer.js";
import { persistedEnumsLayer } from "./persisted-enums/persisted-enums-layer.js";
import { seedLayer } from "./seed/seed-layer.js";
import { sqlMigrationsLayer } from "./sql-migrations/sql-migrations-layer.js";

/** Every layer the CLI knows, in the order they run and appear in reports. Add one line per layer. */
export const LAYERS: Layer[] = [
  openapiLayer,
  sqlMigrationsLayer,
  seedLayer,
  // Refines seed findings whose rows write an added member, so it runs after seed.
  persistedEnumsLayer,
  // Refines openapi and persisted-enums findings, so it runs after both.
  clientUsageLayer,
  errorCodesLayer,
  configLayer,
  dependenciesLayer,
  messageContractsLayer,
  behaviourLayer,
];
