import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { once } from "node:events";
import { randomBytes } from "node:crypto";

import { createApp } from "../../src/app.mjs";
import { SecretVault } from "../../src/secrets.mjs";
import { silentLogger } from "../../src/logger.mjs";

/**
 * 실제 HTTP 서버를 임시 폴더 DB로 띄우고, 쿠키를 유지하는 클라이언트를 함께 돌려줍니다.
 * 라우팅 · 인증 · 오류 처리 경로를 운영과 같은 방식으로 지나가게 하는 것이 목적입니다.
 */
export async function startTestServer({ seedDemoProjects = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "gi-test-"));
  const app = createApp({
    databasePath: join(directory, "test.db"),
    secretVault: new SecretVault({ key: randomBytes(32).toString("base64"), logger: silentLogger }),
    logger: silentLogger,
    rootDirectory: resolve(import.meta.dirname, "..", ".."),
    seedDemoProjects,
    shutdownGraceMs: 50,
  });
  await app.seedDemoProjectsIfNeeded();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const { port } = app.server.address();
  const origin = `http://127.0.0.1:${port}`;

  return {
    app,
    origin,
    bootstrapAdmin: app.bootstrapAdmin,
    database: app.database,
    client: createClient(origin),
    async stop() {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** 쿠키와 CSRF 토큰을 기억하는 최소 클라이언트. */
export function createClient(origin) {
  const cookies = new Map();
  let csrfToken = "";

  function cookieHeader() {
    return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  function storeCookies(response) {
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (/Max-Age=0/i.test(raw)) cookies.delete(name);
      else cookies.set(name, value);
    }
  }

  async function request(path, { method = "GET", body, headers = {}, csrf = true, redirect = "manual" } = {}) {
    const response = await fetch(`${origin}${path}`, {
      method,
      redirect,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookies.size ? { Cookie: cookieHeader() } : {}),
        ...(csrf && csrfToken && method !== "GET" ? { "X-CSRF-Token": csrfToken } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
    storeCookies(response);
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
    if (data?.csrfToken) csrfToken = data.csrfToken;
    return { status: response.status, data, response };
  }

  return {
    request,
    get csrfToken() { return csrfToken; },
    setCsrfToken(token) { csrfToken = token; },
    clearCookies() { cookies.clear(); },
  };
}

/** 최초 관리자로 로그인하고 임시 비밀번호를 실제 비밀번호로 바꿉니다. */
export async function loginAsAdmin(server, newPassword = "Admin!test1234") {
  const login = await server.client.request("/api/auth/login", {
    method: "POST",
    csrf: false,
    body: { loginId: server.bootstrapAdmin.loginId, password: server.bootstrapAdmin.password },
  });
  if (login.status !== 200) throw new Error(`관리자 로그인 실패: ${JSON.stringify(login.data)}`);
  const changed = await server.client.request("/api/auth/password", {
    method: "POST",
    body: { currentPassword: server.bootstrapAdmin.password, newPassword },
  });
  if (changed.status !== 200) throw new Error(`비밀번호 변경 실패: ${JSON.stringify(changed.data)}`);
  return { loginId: server.bootstrapAdmin.loginId, password: newPassword };
}
