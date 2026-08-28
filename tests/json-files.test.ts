import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonFileAtomic } from "../src/agents/shared/json-files.ts";

test("writeJsonFileAtomic does not expose partial JSON to concurrent readers", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "json-files-"));
  const filePath = path.join(tempDir, "job.json");
  const largeValue = "x".repeat(1_000_000);
  let parseError: unknown;
  let stopReading = false;

  await writeFile(filePath, `${JSON.stringify({ status: "initial" })}\n`);

  const reader = (async () => {
    while (!stopReading && !parseError) {
      try {
        JSON.parse(await readFile(filePath, "utf8"));
      } catch (error) {
        parseError = error;
      }
    }
  })();

  try {
    for (let index = 0; index < 20; index += 1) {
      await writeJsonFileAtomic(filePath, {
        status: "running",
        index,
        largeValue
      });
    }

    stopReading = true;
    await reader;

    assert.equal(parseError, undefined);
    assert.deepEqual(await readdir(tempDir), ["job.json"]);
  } finally {
    stopReading = true;
    await reader;
    await rm(tempDir, { recursive: true, force: true });
  }
});
