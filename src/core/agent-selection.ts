import type { AgentSelectionConfig } from "../config/index.ts";

export type AgentTagSource = "label" | "text";

export type AgentSelection = {
  agent: string;
  tag: string;
  source: AgentTagSource;
  usesDefaultAgent: boolean;
};

export type AgentTagCandidate = {
  value: string;
  source: AgentTagSource;
};

export class AmbiguousAgentTagError extends Error {
  readonly agents: string[];

  constructor(agents: string[]) {
    super(`Multiple agent tags matched: ${agents.join(", ")}`);
    this.agents = agents;
  }
}

type ConfiguredAgentTag = {
  normalized: string;
  agent: string;
};

export function selectAgentFromCandidates(
  candidates: AgentTagCandidate[],
  config: AgentSelectionConfig
): AgentSelection | undefined {
  const configuredTags = configuredAgentTagsFromConfig(config);
  const directAgentMatches = candidates.flatMap((candidate) => {
    const normalized = normalizeAgentTag(candidate.value);
    const configuredTag = configuredTags.find((tag) => tag.normalized === normalized);
    return configuredTag ? [{ candidate, configuredTag }] : [];
  });
  const uniqueAgents = Array.from(
    new Set(directAgentMatches.map((match) => match.configuredTag.agent))
  );

  if (uniqueAgents.length > 1) {
    throw new AmbiguousAgentTagError(uniqueAgents);
  }

  const directAgentMatch = directAgentMatches[0];
  if (directAgentMatch) {
    return {
      agent: directAgentMatch.configuredTag.agent,
      tag: directAgentMatch.candidate.value,
      source: directAgentMatch.candidate.source,
      usesDefaultAgent: false
    };
  }

  const triggerTag = normalizeAgentTag(config.triggerTag);
  const defaultTrigger = candidates.find(
    (candidate) => normalizeAgentTag(candidate.value) === triggerTag
  );
  if (!defaultTrigger) {
    return undefined;
  }

  return {
    agent: config.defaultAgent,
    tag: defaultTrigger.value,
    source: defaultTrigger.source,
    usesDefaultAgent: true
  };
}

export function extractDollarTags(text: string): string[] {
  const matches = text.matchAll(/(^|[\s([{<])\$([a-zA-Z0-9][a-zA-Z0-9._:-]{0,80})\b/g);
  return Array.from(matches, (match) => match[2] ?? "");
}

export function normalizeAgentTag(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/g, "-");
}

function configuredAgentTagsFromConfig(
  config: AgentSelectionConfig
): ConfiguredAgentTag[] {
  const seen = new Set<string>();
  const agents = [config.defaultAgent, ...config.tags];

  return agents.flatMap((agent) => {
    const normalized = normalizeAgentTag(agent);
    if (!normalized || seen.has(normalized)) {
      return [];
    }

    seen.add(normalized);
    return [{ normalized, agent }];
  });
}
