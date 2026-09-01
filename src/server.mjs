import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { createApp } from "./app.mjs";
import { Logger } from "./logger.mjs";
import { SecretVault } from "./secrets.mjs";
import {
  APP_NAME,
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_LOG_DIRECTORY,
  DEFAULT_PORT,
  DEFAULT_SECRET_KEY_PATH,
} from "./constants.mjs";

const rootDirectory = resolve(import.meta.dirname, "..");
const configPath = process.env.APP_CONFIG_PATH || join(rootDirectory, "config", "appsettings.json");
if (existsSync(configPath)) {
  const fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
  for (const [key, value] of Object.entries(fileConfig)) {
    if (process.env[key] === undefined && value !== null) process.env[key] = String(value);
  }
}

const logger = new Logger({
  directory: process.env.APP_LOG_DIR || join(rootDirectory, DEFAULT_LOG_DIRECTORY),
  level: process.env.APP_LOG_LEVEL || "info",
  retentionDays: Number(process.env.APP_LOG_RETENTION_DAYS || 30),
});

// 예상치 못한 예외로 서버가 조용히 멈추는 일을 막고, 반드시 기록을 남깁니다.
process.on("uncaughtException", (error) => {
  logger.error("처리되지 않은 예외가 발생했습니다.", { error });
});
process.on("unhandledRejection", (reason) => {
  logger.error("처리되지 않은 프라미스 거부가 발생했습니다.", { error: reason });
});

const secretVault = new SecretVault({
  key: process.env.APP_SECRET_KEY,
  keyPath: process.env.APP_SECRET_KEY_PATH || join(rootDirectory, DEFAULT_SECRET_KEY_PATH),
  logger,
});

const app = createApp({
  databasePath: process.env.APP_DB_PATH || join(rootDirectory, DEFAULT_DB_PATH),
  secretVault,
  logger,
  rootDirectory,
});

await app.seedDemoProjectsIfNeeded();

const port = Number(process.env.APP_PORT || DEFAULT_PORT);
const host = process.env.APP_HOST || DEFAULT_HOST;

app.server.listen(port, host, () => {
  logger.info(`${APP_NAME} ${app.buildInfo.version} 실행: http://${host}:${port}`);
  logger.info(`Node ${process.version}${app.buildInfo.builtAt ? ` · 빌드 ${app.buildInfo.builtAt}` : ""}`);
  logger.info(`아마란스10 모드: ${app.amarance.getConfiguration().mode}`);
  if (host === "0.0.0.0") {
    logger.warn("모든 네트워크 인터페이스에 열려 있습니다. 방화벽으로 접근 범위를 제한하세요.");
  }
});

app.server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    logger.error(`포트 ${port}이(가) 이미 사용 중입니다. 실행 중인 서버를 종료한 뒤 다시 시도해 주세요.`);
  } else {
    logger.error("서버를 시작하지 못했습니다.", { error });
  }
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`종료 신호를 받았습니다: ${signal}`);
  const forceExit = setTimeout(() => process.exit(0), 10_000);
  forceExit.unref();
  await app.close();
  logger.info("정상적으로 종료했습니다.");
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
