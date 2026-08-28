import type { AppConfig } from "../config/index.ts";
import { githubIntegration } from "./github/index.ts";
import type { WebhookIntegration } from "./types.ts";

const integrations: readonly WebhookIntegration[] = [githubIntegration];

export function findIntegrationForPath(
  config: AppConfig,
  pathname: string
): WebhookIntegration | undefined {
  return integrations.find((integration) => integration.routePath(config) === pathname);
}

export function integrationPaths(config: AppConfig): string[] {
  return integrations.map((integration) => integration.routePath(config));
}
