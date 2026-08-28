import type { WorkerResult } from "../types.ts";

type ParsedWorkerResult = {
  result: WorkerResult;
};

export function parseWorkerResult(
  text: string,
  expectedTask: string
): ParsedWorkerResult | undefined {
  const markerPattern = /^[ \t]*(SUPERSET_WORKER_DONE|SUPERSET_WORKER_BLOCKED)[ \t]*$/gm;
  let parsed: ParsedWorkerResult | undefined;
  let match: RegExpExecArray | null;

  while ((match = markerPattern.exec(text)) !== null) {
    const marker = match[1] as WorkerResult["marker"];
    const markerIndex = match.index;
    const envelope = parseEnvelope(text.slice(markerIndex));
    const result = workerResultFromEnvelope(marker, envelope);

    if (isValidWorkerResult(result, expectedTask)) {
      parsed = { result };
    }
  }

  return parsed;
}

function workerResultFromEnvelope(
  marker: WorkerResult["marker"],
  envelope: Record<string, string>
): WorkerResult {
  const doneMatched = marker === "SUPERSET_WORKER_DONE";

  return {
    status: doneMatched ? "completed" : "blocked",
    marker,
    task: envelope.task,
    summary: envelope.summary,
    files: envelope.files,
    checks: envelope.checks,
    handoff: envelope.handoff,
    reason: envelope.reason,
    needs: envelope.needs
  };
}

function isValidWorkerResult(result: WorkerResult, expectedTask: string): boolean {
  if (result.task !== expectedTask) {
    return false;
  }

  if (result.status === "completed") {
    return Boolean(result.summary && !isPlaceholderValue(result.summary));
  }

  return Boolean(
    result.reason &&
      !isPlaceholderValue(result.reason) &&
      result.needs &&
      !isPlaceholderValue(result.needs)
  );
}

function isPlaceholderValue(value: string): boolean {
  return /^<[^>]+>$/.test(value.trim());
}

function parseEnvelope(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/).slice(1);
  const result: Record<string, string> = {};

  for (const line of lines) {
    const match = /^[ \t]*([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    result[match[1] ?? ""] = match[2]?.trim() ?? "";
  }

  return result;
}
