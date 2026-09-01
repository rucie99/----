import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";

import { AmaranceClient } from "./amarance-client.mjs";
import { AppDatabase } from "./database.mjs";
import { AuthService, assertRole } from "./auth.mjs";
import { createRoutes } from "./routes.mjs";
import { describeError, forbidden, notFound, unauthorized } from "./errors.mjs";
import { silentLogger } from "./logger.mjs";
import {
  APP_NAME,
  AUDIT_ACTION,
  CONTENT_TYPE,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
} from "./constants.mjs";
import {
  baseSecurityHeaders,
  buildCookie,
  clientIp,
  expiredCookie,
  isSecureRequest,
  normalizeOrigin,
  parseCookies,
  sendJson,
  sendRedirect,
} from "./http.mjs";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PURGE_INTERVAL_MS = 15 * 60 * 1000;

function contentTypeFor(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".html") return CONTENT_TYPE.HTML;
  if (extension === ".css") return CONTENT_TYPE.CSS;
  if (extension === ".js" || extension === ".mjs") return CONTENT_TYPE.JAVASCRIPT;
  if (extension === ".svg") return CONTENT_TYPE.SVG;
  if (extension === ".ico") return CONTENT_TYPE.ICON;
  if (extension === ".png") return "image/png";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

/**
 * 서버 인스턴스를 만듭니다. 테스트에서도 같은 함수를 써서
 * 실제 라우팅·인증·오류 처리 경로를 그대로 검증합니다.
 */
export function createApp({
  databasePath,
  secretVault,
  logger = silentLogger,
  rootDirectory = resolve(import.meta.dirname, ".."),
  seedDemoProjects = true,
  shutdownGraceMs = 3_000,
} = {}) {
  const publicDirectory = join(rootDirectory, "public");
  const sharedModulePath = join(rootDirectory, "src", "calculations.mjs");

  const database = new AppDatabase({ path: databasePath, secretVault, logger });
  const bootstrapAdmin = database.ensureBootstrapAdmin();
  if (bootstrapAdmin) {
    logger.warn(
      `최초 관리자 계정을 만들었습니다. 로그인 ID: ${bootstrapAdmin.loginId} / 임시 비밀번호: ${bootstrapAdmin.password} — 첫 로그인 시 반드시 변경해 주세요.`,
    );
  }

  const initialAmarance = new AmaranceClient(process.env, { logger });
  const amarance = new AmaranceClient(
    database.initializeAmaranceSettings(initialAmarance.getStoredConfiguration()),
    { logger },
  );
  const auth = new AuthService({ database, logger });
  const routes = createRoutes();

  function allowedOrigins(request) {
    const security = database.getSecuritySettings();
    const host = request.headers.host || "";
    const scheme = isSecureRequest(request, { trustProxy: security.trustProxy }) ? "https" : "http";
    const origins = new Set([normalizeOrigin(`${scheme}://${host}`)]);
    for (const value of security.frameAncestors.split(/\s+/).filter(Boolean)) {
      origins.add(normalizeOrigin(value));
    }
    origins.delete("");
    return origins;
  }

  function cookieOptions(request) {
    const security = database.getSecuritySettings();
    return {
      sameSite: security.cookieSameSite,
      secure: security.cookieSecure || isSecureRequest(request, { trustProxy: security.trustProxy }),
      maxAgeSeconds: security.sessionAbsoluteHours * 3600,
    };
  }

  function buildContext(request, response, url) {
    const security = database.getSecuritySettings();
    const ip = clientIp(request, { trustProxy: security.trustProxy });
    const cookies = parseCookies(request);
    const resolved = auth.resolveSession(cookies.get(SESSION_COOKIE_NAME));
    const setCookies = [];

    const context = {
      request,
      response,
      url,
      ip,
      appName: APP_NAME,
      database,
      amarance,
      auth,
      logger,
      user: resolved?.user || null,
      session: resolved?.session || null,
      startSession(session) {
        context.user = database.getUser(session.userId);
        context.session = session;
        setCookies.push(buildCookie(SESSION_COOKIE_NAME, session.id, cookieOptions(request)));
      },
      endSession() {
        context.user = null;
        context.session = null;
        setCookies.push(expiredCookie(SESSION_COOKIE_NAME, cookieOptions(request)));
      },
      pendingCookieHeader() {
        return setCookies.length ? { "Set-Cookie": setCookies } : {};
      },
      audit(action, targetType, targetId, detail) {
        database.recordAudit({ actor: context.user, action, targetType, targetId, detail, ip });
      },
      applyAmaranceSettings(next) {
        // 저장 전에 형식을 검증해, 잘못된 값이 DB에 들어가지 않게 합니다.
        const validated = new AmaranceClient(next, { logger }).getStoredConfiguration();
        amarance.configure(database.saveAmaranceSettings(validated));
      },
    };
    return context;
  }

  /** 상태 변경 요청에 대한 출처(Origin) 확인과 CSRF 토큰 확인. */
  function assertRequestIsTrusted(context, route) {
    const { request } = context;
    if (SAFE_METHODS.has(request.method)) return;

    const origin = normalizeOrigin(request.headers.origin);
    if (origin && !allowedOrigins(request).has(origin)) {
      logger.warn("허용되지 않은 출처에서 변경 요청이 들어왔습니다.", { origin, path: context.url.pathname });
      throw forbidden("허용되지 않은 출처의 요청입니다.");
    }
    if (route.role === null) return;

    const token = String(request.headers[CSRF_HEADER_NAME] || "");
    if (!token || !context.session || token !== context.session.csrfToken) {
      throw forbidden("보안 토큰이 유효하지 않습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.");
    }
  }

  function matchRoute(method, pathname) {
    let methodMismatch = false;
    for (const route of routes) {
      const match = pathname.match(route.pattern);
      if (!match) continue;
      if (route.method !== method) {
        methodMismatch = true;
        continue;
      }
      return { route, parameters: match.slice(1) };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }

  async function handleApi(context) {
    const matched = matchRoute(context.request.method, context.url.pathname);
    if (!matched) throw notFound("요청한 API를 찾을 수 없습니다.");
    if (matched.methodMismatch) throw notFound("요청한 API를 찾을 수 없습니다.");

    const { route, parameters } = matched;
    if (route.role !== null) {
      if (!context.user) throw unauthorized();
      assertRole(context.user, route.role);
      // 임시 비밀번호 상태에서는 비밀번호 변경과 세션 조회만 허용합니다.
      if (context.user.mustChangePassword
        && !/^\/api\/(auth\/(password|logout)|session|health)$/.test(context.url.pathname)) {
        throw forbidden("임시 비밀번호를 사용 중입니다. 비밀번호를 먼저 변경해 주세요.", "PASSWORD_CHANGE_REQUIRED");
      }
    }
    assertRequestIsTrusted(context, route);
    await route.handle(context, parameters);
  }

  /** 아마란스10 메뉴트리에서 넘어온 진입 요청. 검증 후 세션을 발급하고 홈으로 보냅니다. */
  async function handleSso(context) {
    const verified = context.auth.verifySsoRequest(context.url.searchParams, { ip: context.ip });
    const { user, session } = context.auth.establishSsoSession(verified, {
      ip: context.ip,
      userAgent: context.request.headers["user-agent"],
    });
    context.startSession(session);
    database.recordAudit({ actor: user, action: AUDIT_ACTION.LOGIN_SSO, ip: context.ip, detail: "아마란스10 메뉴 진입" });
    logger.info("아마란스10 메뉴 진입으로 로그인했습니다.", { loginId: user.loginId, ip: context.ip });
    sendRedirect(context.response, "/", {
      ...context.pendingCookieHeader(),
      ...baseSecurityHeaders({ frameAncestors: frameAncestorsValue() }),
    });
  }

  function frameAncestorsValue() {
    const configured = database.getSecuritySettings().frameAncestors.trim();
    return configured ? `'self' ${configured}` : "'self'";
  }

  function resolveStaticPath(pathname) {
    const safePath = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = resolve(publicDirectory, `.${safePath}`);
    // 접두사만 비교하면 public-backup 같은 형제 폴더가 통과할 수 있으므로 구분자까지 확인합니다.
    if (filePath !== publicDirectory && !filePath.startsWith(publicDirectory + sep)) return null;
    if (!existsSync(filePath)) return null;
    const stats = statSync(filePath);
    return stats.isFile() ? { filePath, stats } : null;
  }

  function serveFile(context, filePath, stats, { cacheControl = "no-cache" } = {}) {
    const { request, response } = context;
    const etag = `W/"${stats.size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
    const headers = {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": cacheControl,
      ETag: etag,
      "Last-Modified": stats.mtime.toUTCString(),
      ...baseSecurityHeaders({ frameAncestors: frameAncestorsValue() }),
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Length": stats.size });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(filePath);
    // 스트림 오류를 처리하지 않으면 처리되지 않은 error 이벤트로 프로세스가 종료됩니다.
    stream.on("error", (error) => {
      logger.error("정적 파일을 읽는 중 오류가 발생했습니다.", { filePath, error });
      response.destroy();
    });
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }

  function servePage(context, fileName) {
    const filePath = join(publicDirectory, fileName);
    if (!existsSync(filePath)) throw notFound("요청한 페이지를 찾을 수 없습니다.");
    serveFile(context, filePath, statSync(filePath), { cacheControl: "no-store" });
  }

  async function handleRequest(request, response) {
    const startedAt = Date.now();
    let url;
    try {
      url = new URL(request.url || "/", "http://localhost");
    } catch {
      sendJson(response, 400, { message: "요청 주소가 올바르지 않습니다." });
      return;
    }
    const context = buildContext(request, response, url);
    const { pathname } = url;

    try {
      if (pathname.startsWith("/api/")) {
        await handleApi(context);
        return;
      }
      if (pathname === "/sso") {
        await handleSso(context);
        return;
      }
      if (pathname === "/shared/calculations.mjs") {
        serveFile(context, sharedModulePath, statSync(sharedModulePath));
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        if (!context.user) {
          sendRedirect(response, "/login", baseSecurityHeaders({ frameAncestors: frameAncestorsValue() }));
          return;
        }
        servePage(context, "index.html");
        return;
      }
      if (pathname === "/login") {
        if (context.user && !context.user.mustChangePassword) {
          sendRedirect(response, "/", baseSecurityHeaders({ frameAncestors: frameAncestorsValue() }));
          return;
        }
        servePage(context, "login.html");
        return;
      }
      const staticFile = resolveStaticPath(pathname);
      if (staticFile) {
        serveFile(context, staticFile.filePath, staticFile.stats);
        return;
      }
      throw notFound("요청한 페이지를 찾을 수 없습니다.");
    } catch (error) {
      const described = describeError(error);
      if (described.internal) {
        logger.error("요청 처리 중 예기치 못한 오류가 발생했습니다.", {
          method: request.method,
          path: pathname,
          loginId: context.user?.loginId,
          error,
        });
      } else if (described.statusCode >= 400 && described.statusCode !== 404) {
        logger.warn("요청이 거부되었습니다.", {
          method: request.method,
          path: pathname,
          status: described.statusCode,
          code: described.code,
          loginId: context.user?.loginId,
        });
      }
      sendJson(response, described.statusCode, { message: described.message, code: described.code }, {
        ...context.pendingCookieHeader(),
        ...baseSecurityHeaders({ frameAncestors: frameAncestorsValue() }),
      });
    } finally {
      if (pathname.startsWith("/api/") && pathname !== "/api/health") {
        logger.debug("요청 처리", {
          method: request.method,
          path: pathname,
          status: response.statusCode,
          ms: Date.now() - startedAt,
          loginId: context.user?.loginId,
        });
      }
    }
  }

  const server = createServer((request, response) => {
    handleRequest(request, response).catch((error) => {
      logger.error("요청 처리 파이프라인에서 오류가 발생했습니다.", { error });
      if (!response.headersSent) {
        sendJson(response, 500, { message: "처리 중 오류가 발생했습니다.", code: "INTERNAL_ERROR" });
      } else {
        response.destroy();
      }
    });
  });

  server.on("clientError", (error, socket) => {
    if (!socket.writable) return;
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;

  const purgeTimer = setInterval(() => {
    try {
      const purged = database.purgeExpired();
      if (purged.sessions || purged.nonces) logger.debug("만료 데이터를 정리했습니다.", purged);
    } catch (error) {
      logger.error("만료 데이터 정리에 실패했습니다.", { error });
    }
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref?.();

  async function seedDemoProjectsIfNeeded() {
    if (!seedDemoProjects) return;
    if (database.listProjects().length > 0) return;
    if (amarance.getConfiguration().mode !== "DEMO") return;
    database.upsertProjects(await amarance.searchProjects());  // 최초 DEMO 시드 — 대조는 하지 않습니다
  }

  function close() {
    clearInterval(purgeTimer);
    return new Promise((resolveClose) => {
      server.close(() => {
        clearTimeout(forceTimer);
        try {
          database.close();
        } catch {
          /* 이미 닫힌 경우는 무시합니다. */
        }
        resolveClose();
      });
      // 놀고 있는 연결은 즉시 끊고, 남은 연결도 정해진 시간 안에 정리해
      // 종료가 keep-alive 타임아웃만큼 늘어지지 않게 합니다.
      server.closeIdleConnections?.();
      const forceTimer = setTimeout(() => server.closeAllConnections?.(), shutdownGraceMs);
      forceTimer.unref?.();
    });
  }

  return { server, database, amarance, auth, logger, bootstrapAdmin, seedDemoProjectsIfNeeded, close };
}
