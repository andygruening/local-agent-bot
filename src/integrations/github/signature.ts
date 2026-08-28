import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export function getHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}

export function verifyGitHubSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined
): boolean {
  if (!signatureHeader) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const actualBuffer = Buffer.from(signatureHeader, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (actualBuffer.byteLength !== expectedBuffer.byteLength) {
    return false;
  }

  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function deliveryIdFromHeaders(headers: IncomingHttpHeaders): string {
  return getHeader(headers, "x-github-delivery") ?? randomUUID();
}

export function eventNameFromHeaders(headers: IncomingHttpHeaders): string {
  return getHeader(headers, "x-github-event") ?? "unknown";
}
