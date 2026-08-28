import path from "node:path";
import type {
  AppConfig,
  GitHubReactionContent
} from "./types.ts";

export type {
  AgentConfig,
  AgentSelectionConfig,
  AppConfig,
  CodexAgentRunnerConfig,
  CoreConfig,
  GitHubIntegrationConfig,
  GitHubReactionContent,
  IntegrationConfig,
  SupersetAgentRunnerConfig
} from "./types.ts";

export function readConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const agentRunner = readString(env.AGENT_RUNNER, "superset").toLowerCase();
  const supersetDefaultAgent = readString(
    env.SUPERSET_DEFAULT_AGENT ?? env.SUPERSET_DEFAULT_AGENT_MODEL,
    "codex"
  );
  const codexDefaultModel = readString(
    env.CODEX_DEFAULT_MODEL ?? env.CODEX_MODEL,
    "gpt-5.5"
  );
  const defaultAgent = readString(
    env.AGENT_DEFAULT,
    agentRunner === "codex" ? codexDefaultModel : supersetDefaultAgent
  );
  const supersetAgentTags = readStringList(
    env.SUPERSET_AGENT_TAGS ?? env.SUPERSET_AGENT_MODEL_TAGS,
    "codex,claude"
  );
  const agentTags = readStringList(
    env.AGENT_TAGS,
    agentRunner === "codex" ? codexDefaultModel : supersetAgentTags.join(",")
  );

  return {
    core: {
      host: readString(env.HOST, "127.0.0.1"),
      port: readPositiveInt(env.PORT, 8787, "PORT"),
      eventDir: path.resolve(readString(env.WEBHOOK_EVENT_DIR, ".webhook-events")),
      maxBodyBytes: readPositiveInt(env.MAX_BODY_BYTES, 25_000_000, "MAX_BODY_BYTES"),
      allowedEvents: readAllowedEvents(env.ALLOWED_EVENTS),
      dryRun: readBoolean(env.DRY_RUN, false),
      promptPrefix: readOptionalString(env.AGENT_PROMPT_PREFIX)
    },
    agents: {
      runner: agentRunner,
      selection: {
        triggerTag: readString(env.AGENT_TRIGGER_TAG, "agent"),
        defaultAgent,
        tags: agentTags
      },
      superset: {
        command: readString(env.SUPERSET_COMMAND, "superset"),
        workspaceId: readOptionalString(env.SUPERSET_WORKSPACE_ID),
        hostId: readOptionalString(env.SUPERSET_HOST_ID),
        defaultAgent: supersetDefaultAgent,
        tags: supersetAgentTags,
        extraArgs: readStringArray(env.SUPERSET_EXTRA_ARGS_JSON, "SUPERSET_EXTRA_ARGS_JSON"),
        envPassthrough: readStringArray(
          env.SUPERSET_ENV_PASSTHROUGH_JSON,
          "SUPERSET_ENV_PASSTHROUGH_JSON",
          ["SUPERSET_API_KEY", "SUPERSET_API_URL"]
        ),
        terminalPollIntervalMs: readPositiveInt(
          env.SUPERSET_TERMINAL_POLL_INTERVAL_MS,
          10_000,
          "SUPERSET_TERMINAL_POLL_INTERVAL_MS"
        ),
        terminalMaxPolls: readPositiveInt(
          env.SUPERSET_TERMINAL_MAX_POLLS,
          360,
          "SUPERSET_TERMINAL_MAX_POLLS"
        )
      },
      codex: {
        command: readString(env.CODEX_COMMAND, "codex"),
        defaultModel: codexDefaultModel,
        extraArgs: readStringArray(env.CODEX_EXTRA_ARGS_JSON, "CODEX_EXTRA_ARGS_JSON"),
        envPassthrough: readStringArray(
          env.CODEX_ENV_PASSTHROUGH_JSON,
          "CODEX_ENV_PASSTHROUGH_JSON",
          ["OPENAI_API_KEY", "CODEX_HOME"]
        ),
        sandbox: readOptionalEnum(
          env.CODEX_SANDBOX,
          "CODEX_SANDBOX",
          ["read-only", "workspace-write", "danger-full-access"] as const
        ),
        approvalPolicy: readOptionalEnum(
          env.CODEX_APPROVAL_POLICY,
          "CODEX_APPROVAL_POLICY",
          ["untrusted", "on-request", "never"] as const
        ),
        workingDirectory: readOptionalString(env.CODEX_WORKING_DIRECTORY),
        execTimeoutMs: readPositiveInt(
          env.CODEX_EXEC_TIMEOUT_MS,
          3_600_000,
          "CODEX_EXEC_TIMEOUT_MS"
        )
      }
    },
    integrations: {
      github: {
        webhookPath: normalizePath(readString(env.GITHUB_WEBHOOK_PATH, "/webhooks/github")),
        webhookSecret: readOptionalString(env.GITHUB_WEBHOOK_SECRET),
        responseEnabled: readBoolean(env.GITHUB_RESPONSE_ENABLED, true),
        contextEnabled: readBoolean(env.GITHUB_CONTEXT_ENABLED, true),
        contextInlineMaxBytes: readPositiveInt(
          env.GITHUB_CONTEXT_INLINE_MAX_BYTES,
          120_000,
          "GITHUB_CONTEXT_INLINE_MAX_BYTES"
        ),
        command: readString(env.GITHUB_COMMAND, "gh"),
        completionReaction: readGitHubCompletionReaction(
          env.GITHUB_COMPLETION_REACTION,
          "+1"
        ),
        envPassthrough: readStringArray(
          env.GITHUB_ENV_PASSTHROUGH_JSON,
          "GITHUB_ENV_PASSTHROUGH_JSON",
          ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST"]
        )
      }
    }
  };
}

function readOptionalEnum<TAllowed extends readonly string[]>(
  value: string | undefined,
  name: string,
  allowed: TAllowed
): TAllowed[number] | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }

  if (allowed.includes(raw)) {
    return raw;
  }

  throw new Error(`${name} must be one of ${allowed.join(", ")}`);
}

function normalizePath(value: string): string {
  return value.startsWith("/") ? value : `/${value}`;
}

function readString(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function readOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readPositiveInt(value: string | undefined, fallback: number, name: string): number {
  const raw = readOptionalString(value);
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }

  throw new Error(`Expected a boolean value but received "${value}"`);
}

function readGitHubCompletionReaction(
  value: string | undefined,
  fallback: Exclude<GitHubReactionContent, "eyes">
): Exclude<GitHubReactionContent, "eyes"> {
  const raw = readOptionalString(value);
  if (!raw) {
    return fallback;
  }

  const allowed = ["+1", "-1", "laugh", "confused", "heart", "hooray", "rocket"] as const;
  if (allowed.includes(raw as (typeof allowed)[number])) {
    return raw as (typeof allowed)[number];
  }

  throw new Error(
    `GITHUB_COMPLETION_REACTION must be one of ${allowed.join(", ")}`
  );
}

function readAllowedEvents(value: string | undefined): ReadonlySet<string> | undefined {
  const raw = readOptionalString(value);
  if (!raw) {
    return undefined;
  }

  const events = raw
    .split(",")
    .map((eventName) => eventName.trim())
    .filter(Boolean);

  return events.length > 0 ? new Set(events) : undefined;
}

function readStringList(value: string | undefined, fallback: string): string[] {
  return readString(value, fallback)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readStringArray(
  value: string | undefined,
  name: string,
  fallback: string[] = []
): string[] {
  const raw = readOptionalString(value);
  if (!raw) {
    return fallback;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be a JSON array of strings`, { cause: error });
  }

  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }

  return parsed;
}
