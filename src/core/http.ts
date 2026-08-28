import type { IncomingMessage, ServerResponse } from "node:http";

export class PayloadTooLargeError extends Error {
  readonly maxBodyBytes: number;

  constructor(maxBodyBytes: number) {
    super(`Request body exceeded ${maxBodyBytes} bytes`);
    this.maxBodyBytes = maxBodyBytes;
  }
}

export async function readRequestBody(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let settled = false;

  return await new Promise<Buffer>((resolve, reject) => {
    request.on("data", (chunk: Buffer) => {
      if (settled) {
        return;
      }

      totalBytes += chunk.byteLength;
      if (totalBytes > maxBodyBytes) {
        settled = true;
        request.resume();
        reject(new PayloadTooLargeError(maxBodyBytes));
        return;
      }

      chunks.push(chunk);
    });

    request.on("end", () => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(Buffer.concat(chunks, totalBytes));
    });

    request.on("error", (error) => {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });
  });
}

export function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  if (response.headersSent) {
    return;
  }

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

export function summarizeHeaders(
  request: IncomingMessage
): Record<string, string | undefined> {
  return {
    host: getHeader(request.headers, "host"),
    userAgent: getHeader(request.headers, "user-agent"),
    contentType: getHeader(request.headers, "content-type"),
    contentLength: getHeader(request.headers, "content-length"),
    cfRay: getHeader(request.headers, "cf-ray")
  };
}

function getHeader(
  headers: IncomingMessage["headers"],
  name: string
): string | undefined {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }

  return value;
}
