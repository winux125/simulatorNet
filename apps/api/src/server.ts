import { buildApi } from "./app";

const app = await buildApi({ logger: true });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "127.0.0.1";

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "graceful shutdown");
  await app.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
