import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

import { AmaranceClient } from "./amarance-client.mjs";
import { AppDatabase } from "./database.mjs";
import { createSnapshotWorkbook } from "./xlsx-export.mjs";
import {
  APP_NAME,
  CONTENT_TYPE,
  DEFAULT_DB_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_REQUEST_BYTES,
} from "./constants.mjs";

const rootDirectory = resolve(import.meta.dirname, "..");
const publicDirectory = join(rootDirectory, "public");
const configPath = process.env.APP_CONFIG_PATH || join(rootDirectory, "config", "appsettings.json");
if (existsSync(configPath)) {
  const fileConfig = JSON.parse(readFileSync(configPath, "utf8"));
  for (const [key, value] of Object.entries(fileConfig)) {
    if (process.env[key] === undefined && value !== null) process.env[key] = String(value);
  }
}
const database = new AppDatabase(process.env.APP_DB_PATH || join(rootDirectory, DEFAULT_DB_PATH));
const initialAmarance = new AmaranceClient();
const amarance = new AmaranceClient(database.initializeAmaranceSettings(initialAmarance.getStoredConfiguration()));

if (database.listProjects().length === 0 && amarance.getConfiguration().mode === "DEMO") {
  database.upsertProjects(await amarance.searchProjects());
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    "Content-Type": CONTENT_TYPE.JSON,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(data));
}

function sendNoContent(response) {
  response.writeHead(204, { "Cache-Control": "no-store" });
  response.end();
}

function sendWorkbook(response, workbook, filename) {
  const encodedFilename = encodeURIComponent(filename).replaceAll("'", "%27");
  response.writeHead(200, {
    "Content-Type": CONTENT_TYPE.XLSX,
    "Content-Disposition": `attachment; filename="progress-statement.xlsx"; filename*=UTF-8''${encodedFilename}`,
    "Content-Length": workbook.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(workbook);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("요청 데이터가 너무 큽니다.");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function numberParam(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name}이(가) 올바르지 않습니다.`);
  return parsed;
}

async function handleApi(request, response, pathname) {
  const method = request.method || "GET";
  let match;

  if (method === "GET" && pathname === "/api/bootstrap") {
    sendJson(response, 200, {
      appName: APP_NAME,
      categories: database.listCategories(),
      projects: database.listProjects(),
      amarance: amarance.getConfiguration(),
    });
    return true;
  }

  if (method === "GET" && pathname === "/api/categories") {
    sendJson(response, 200, database.listCategories());
    return true;
  }

  if (method === "POST" && pathname === "/api/major-categories") {
    sendJson(response, 201, database.createMajorCategory(await readJson(request)));
    return true;
  }
  if ((match = pathname.match(/^\/api\/major-categories\/(\d+)$/))) {
    const id = numberParam(match[1], "대분류 ID");
    if (method === "PUT") {
      database.updateMajorCategory(id, await readJson(request));
      sendNoContent(response);
      return true;
    }
    if (method === "DELETE") {
      database.deleteMajorCategory(id);
      sendNoContent(response);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/middle-categories") {
    sendJson(response, 201, database.createMiddleCategory(await readJson(request)));
    return true;
  }
  if ((match = pathname.match(/^\/api\/middle-categories\/(\d+)$/))) {
    const id = numberParam(match[1], "중분류 ID");
    if (method === "PUT") {
      database.updateMiddleCategory(id, await readJson(request));
      sendNoContent(response);
      return true;
    }
    if (method === "DELETE") {
      database.deleteMiddleCategory(id);
      sendNoContent(response);
      return true;
    }
  }

  if (method === "POST" && pathname === "/api/item-mappings") {
    sendJson(response, 201, database.createItemMapping(await readJson(request)));
    return true;
  }
  if ((match = pathname.match(/^\/api\/item-mappings\/(\d+)$/)) && method === "DELETE") {
    database.deleteItemMapping(numberParam(match[1], "품번 연결 ID"));
    sendNoContent(response);
    return true;
  }

  if (method === "POST" && pathname === "/api/amarance/items/search") {
    const body = await readJson(request);
    sendJson(response, 200, await amarance.searchItems(String(body.query ?? "")));
    return true;
  }

  if (method === "GET" && pathname === "/api/amarance/settings") {
    sendJson(response, 200, amarance.getConfiguration());
    return true;
  }

  if (method === "PUT" && pathname === "/api/amarance/settings") {
    const body = await readJson(request);
    const current = database.getAmaranceSettings();
    const next = {
      mode: body.mode,
      baseUrl: body.baseUrl,
      companyCode: body.companyCode,
      callerName: body.callerName,
      groupSeq: body.groupSeq,
      accessToken: body.clearAccessToken ? "" : String(body.accessToken || current.accessToken),
      hashKey: body.clearHashKey ? "" : String(body.hashKey || current.hashKey),
    };
    const validated = new AmaranceClient(next).getStoredConfiguration();
    amarance.configure(database.saveAmaranceSettings(validated));
    sendJson(response, 200, amarance.getConfiguration());
    return true;
  }

  if (method === "POST" && pathname === "/api/amarance/settings/test") {
    const projects = await amarance.searchProjects();
    sendJson(response, 200, {
      mode: amarance.getConfiguration().mode,
      projectCount: projects.length,
      message: `프로젝트 조회에 성공했습니다. ${projects.length.toLocaleString("ko-KR")}건을 확인했습니다.`,
    });
    return true;
  }

  if (method === "POST" && pathname === "/api/projects/sync") {
    sendJson(response, 200, database.upsertProjects(await amarance.searchProjects()));
    return true;
  }

  if ((match = pathname.match(/^\/api\/projects\/(\d+)\/snapshots$/))) {
    const projectId = numberParam(match[1], "프로젝트 ID");
    if (method === "GET") {
      sendJson(response, 200, database.listSnapshots(projectId));
      return true;
    }
    if (method === "POST") {
      const body = await readJson(request);
      sendJson(response, 201, database.createSnapshot(projectId, {
        cloneSnapshotId: body.cloneSnapshotId ? numberParam(body.cloneSnapshotId, "복제 버전 ID") : null,
      }));
      return true;
    }
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)$/)) && method === "GET") {
    sendJson(response, 200, database.getSnapshot(numberParam(match[1], "스냅샷 ID")));
    return true;
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)\/export\.xlsx$/)) && method === "GET") {
    const snapshot = database.getSnapshot(numberParam(match[1], "스냅샷 ID"));
    const filename = `기성집행서_${snapshot.projectCode}_v${snapshot.versionNo}.xlsx`;
    sendWorkbook(response, createSnapshotWorkbook(snapshot), filename);
    return true;
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)\/lines$/)) && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, database.updateSnapshotLines(
      numberParam(match[1], "스냅샷 ID"),
      body.lines,
    ));
    return true;
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)\/lines\/(\d+)$/)) && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, database.updateSnapshotLine(
      numberParam(match[1], "스냅샷 ID"),
      numberParam(match[2], "항목 ID"),
      body,
    ));
    return true;
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)\/status$/)) && method === "PUT") {
    const body = await readJson(request);
    sendJson(response, 200, database.setSnapshotStatus(numberParam(match[1], "스냅샷 ID"), body.status));
    return true;
  }

  if ((match = pathname.match(/^\/api\/snapshots\/(\d+)\/receipts\/import$/)) && method === "POST") {
    const snapshotId = numberParam(match[1], "스냅샷 ID");
    const body = await readJson(request);
    const snapshot = database.getSnapshot(snapshotId);
    const receipts = await amarance.fetchReceipts({
      projectCode: snapshot.projectCode,
      fromDate: body.fromDate,
      toDate: body.toDate,
    });
    sendJson(response, 200, database.importReceipts(snapshotId, receipts));
    return true;
  }

  return false;
}

function contentTypeFor(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".html") return CONTENT_TYPE.HTML;
  if (extension === ".css") return CONTENT_TYPE.CSS;
  if (extension === ".js" || extension === ".mjs") return CONTENT_TYPE.JAVASCRIPT;
  if (extension === ".svg") return CONTENT_TYPE.SVG;
  return "application/octet-stream";
}

function serveStatic(response, pathname) {
  const requestPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requestPath).replace(/^(\.\.[/\\])+/, "");
  const filePath = resolve(publicDirectory, `.${safePath}`);
  if (!filePath.startsWith(publicDirectory) || !existsSync(filePath) || !statSync(filePath).isFile()) return false;
  response.writeHead(200, {
    "Content-Type": contentTypeFor(filePath),
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
  });
  createReadStream(filePath).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      if (!await handleApi(request, response, url.pathname)) sendJson(response, 404, { message: "요청한 API를 찾을 수 없습니다." });
      return;
    }
    if (!serveStatic(response, url.pathname)) sendJson(response, 404, { message: "요청한 페이지를 찾을 수 없습니다." });
  } catch (error) {
    const message = error instanceof Error ? error.message : "처리 중 오류가 발생했습니다.";
    const statusCode = message.includes("찾을 수 없습니다") ? 404 : 400;
    sendJson(response, statusCode, { message });
  }
});

const port = Number(process.env.APP_PORT || DEFAULT_PORT);
const host = process.env.APP_HOST || DEFAULT_HOST;
server.listen(port, host, () => {
  console.log(`${APP_NAME} 실행: http://${host}:${port}`);
  console.log(`아마란스10 모드: ${amarance.getConfiguration().mode}`);
});

function shutdown() {
  server.close(() => {
    database.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
