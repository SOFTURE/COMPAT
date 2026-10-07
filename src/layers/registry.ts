import { configLayer } from "./config/config-layer.js";
import type { Layer } from "./layer.js";
import { openapiLayer } from "./openapi/openapi-layer.js";
import { persistedEnumsLayer } from "./persisted-enums/persisted-enums-layer.js";
import { seedLayer } from "./seed/seed-layer.js";
import { sqlMigrationsLayer } from "./sql-migrations/sql-migrations-layer.js";

/** Every layer the CLI knows, in the order they run and appear in reports. Add one line per layer. */
export const LAYERS: Layer[] = [
  openapiLayer,
  sqlMigrationsLayer,
  seedLayer,
  persistedEnumsLayer,
  configLayer,
];
