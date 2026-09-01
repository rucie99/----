import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const LEVEL_RANK = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function safeStringify(value) {
  try {
    return JSON.stringify(value, (key, item) => {
      if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
      return item;
    });
  } catch {
    return String(value);
  }
}

/**
 * 파일과 콘솔에 동시에 남기는 최소 로거.
 * 예약 작업(SYSTEM 계정)으로 실행되면 콘솔 출력이 어디에도 남지 않으므로
 * 장애 추적을 위해 파일 로그가 반드시 필요합니다.
 */
export class Logger {
  constructor({ directory, level = "info", retentionDays = 30, console: useConsole = true } = {}) {
    this.directory = directory ? resolve(directory) : null;
    this.level = LEVEL_RANK[level] ? level : "info";
    this.retentionDays = Number(retentionDays) > 0 ? Number(retentionDays) : 30;
    this.useConsole = useConsole;
    this.failed = false;
    if (this.directory) {
      try {
        mkdirSync(this.directory, { recursive: true });
        this.cleanup();
      } catch (error) {
        this.failed = true;
        console.error(`로그 폴더를 만들지 못했습니다: ${error.message}`);
      }
    }
  }

  filePathFor(date = new Date()) {
    return join(this.directory, `app-${date.toISOString().slice(0, 10)}.log`);
  }

  cleanup() {
    const limit = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(this.directory)) {
      if (!/^app-\d{4}-\d{2}-\d{2}\.log$/.test(name)) continue;
      const path = join(this.directory, name);
      try {
        if (statSync(path).mtimeMs < limit) rmSync(path, { force: true });
      } catch {
        /* 정리 실패는 무시합니다. */
      }
    }
  }

  write(level, message, context) {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.level]) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${context ? ` ${safeStringify(context)}` : ""}`;
    if (this.useConsole) {
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    }
    if (!this.directory || this.failed) return;
    try {
      appendFileSync(this.filePathFor(), `${line}\n`, "utf8");
    } catch (error) {
      this.failed = true;
      console.error(`로그 파일 기록에 실패했습니다: ${error.message}`);
    }
  }

  debug(message, context) { this.write("debug", message, context); }
  info(message, context) { this.write("info", message, context); }
  warn(message, context) { this.write("warn", message, context); }
  error(message, context) { this.write("error", message, context); }
}

/** 테스트처럼 파일을 남길 필요가 없는 곳에서 쓰는 조용한 로거. */
export const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
};
