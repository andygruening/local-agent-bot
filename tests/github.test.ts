import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyGitHubSignature } from "../src/integrations/github/signature.ts";

test("verifyGitHubSignature accepts a valid sha256 signature", () => {
  const secret = "top-secret";
  const body = Buffer.from(JSON.stringify({ zen: "Keep it logically awesome." }));
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

  assert.equal(verifyGitHubSignature(secret, body, signature), true);
});

test("verifyGitHubSignature rejects invalid and missing signatures", () => {
  const body = Buffer.from("{}");

  assert.equal(verifyGitHubSignature("top-secret", body, "sha256=bad"), false);
  assert.equal(verifyGitHubSignature("top-secret", body, undefined), false);
});
