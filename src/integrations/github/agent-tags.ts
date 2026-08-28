import type { AgentSelectionConfig } from "../../config/index.ts";
import {
  extractDollarTags,
  selectAgentFromCandidates,
  type AgentSelection,
  type AgentTagCandidate
} from "../../core/agent-selection.ts";

export {
  AmbiguousAgentTagError,
  type AgentSelection
} from "../../core/agent-selection.ts";

export function selectAgentFromGitHubPayload(
  payload: unknown,
  config: AgentSelectionConfig,
  eventName = "unknown"
): AgentSelection | undefined {
  const candidates = extractTagCandidates(payload, eventName);
  return selectAgentFromCandidates(candidates, config);
}

function extractTagCandidates(payload: unknown, eventName: string): AgentTagCandidate[] {
  const candidates: AgentTagCandidate[] = [];

  for (const label of extractLabels(payload, eventName)) {
    candidates.push({ value: label, source: "label" });
  }

  for (const text of extractTexts(payload, eventName)) {
    for (const tag of extractDollarTags(text)) {
      candidates.push({ value: tag, source: "text" });
    }
  }

  return candidates;
}

function extractLabels(payload: unknown, eventName: string): string[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (isCommentEvent(eventName)) {
    return [];
  }

  const labels = [
    ...labelsFromValue(payload.label),
    ...labelsFromValue(isRecord(payload.issue) ? payload.issue.labels : undefined),
    ...labelsFromValue(isRecord(payload.pull_request) ? payload.pull_request.labels : undefined)
  ];

  return labels.filter(Boolean);
}

function labelsFromValue(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }

    if (isRecord(item) && typeof item.name === "string") {
      return [item.name];
    }

    return [];
  });
}

function extractTexts(payload: unknown, eventName: string): string[] {
  if (!isRecord(payload)) {
    return [];
  }

  if (isCommentEvent(eventName)) {
    return [readBody(payload.comment)].filter((value): value is string => Boolean(value));
  }

  if (eventName === "pull_request_review") {
    return [readBody(payload.review)].filter((value): value is string => Boolean(value));
  }

  return [
    readBody(payload.comment),
    readBody(payload.issue),
    readBody(payload.pull_request),
    readBody(payload.discussion),
    readBody(payload.review),
    typeof payload.body === "string" ? payload.body : undefined
  ].filter((value): value is string => Boolean(value));
}

function isCommentEvent(eventName: string): boolean {
  return [
    "commit_comment",
    "discussion_comment",
    "issue_comment",
    "pull_request_review_comment"
  ].includes(eventName);
}

function readBody(value: unknown): string | undefined {
  return isRecord(value) && typeof value.body === "string" ? value.body : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
