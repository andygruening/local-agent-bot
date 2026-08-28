import { readConfig } from "./config/index.ts";
import { PayloadTooLargeError } from "./core/http.ts";
import { createWebhookServer } from "./core/server.ts";
import { integrationPaths } from "./integrations/registry.ts";

try {
  const config = readConfig();
  const server = createWebhookServer(config);

  server.on("clientError", (error, socket) => {
    console.warn(
      "Rejected malformed client request:",
      JSON.stringify(
        {
          receivedAt: new Date().toISOString(),
          remoteAddress: "remoteAddress" in socket ? socket.remoteAddress : undefined,
          error: {
            name: error.name,
            message: error.message,
            code: "code" in error ? error.code : undefined
          }
        },
        null,
        2
      )
    );

    if (error instanceof PayloadTooLargeError) {
      socket.end("HTTP/1.1 413 Payload Too Large\r\n\r\n");
      return;
    }

    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  server.listen(config.core.port, config.core.host, () => {
    const secretStatus = config.integrations.github.webhookSecret
      ? "signature verification on"
      : "unsigned mode";
    const dryRunStatus = config.core.dryRun
      ? "dry run"
      : `launching ${config.agents.runner} agents`;
    const paths = integrationPaths(config).join(", ");
    console.log(
      `Webhook receiver listening on http://${config.core.host}:${config.core.port} for ${paths} (${secretStatus}, ${dryRunStatus})`
    );
  });
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
