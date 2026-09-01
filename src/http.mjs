import { CONTENT_TYPE, MAX_REQUEST_BYTES } from "./constants.mjs";
import { badRequest, payloadTooLarge } from "./errors.mjs";

/** 응답 종류와 무관하게 항상 붙이는 보안 헤더. */
export function baseSecurityHeaders({ frameAncestors = "'self'" } = {}) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "img-src 'self' data:",
      "style-src 'self'",
      "script-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      `frame-ancestors ${frameAncestors}`,
    ].join("; "),
  };
}

export function sendJson(response, statusCode, data, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "Content-Type": CONTENT_TYPE.JSON,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end(JSON.stringify(data));
}

export function sendNoContent(response, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(204, {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extraHeaders,
  });
  response.end();
}

export function sendRedirect(response, location, extraHeaders = {}) {
  if (response.headersSent) return;
  response.writeHead(302, { Location: location, "Cache-Control": "no-store", ...extraHeaders });
  response.end();
}

export function sendBuffer(response, statusCode, buffer, headers = {}) {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "Content-Length": buffer.length,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(buffer);
}

export async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw payloadTooLarge();
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw badRequest("요청 본문 형식이 올바르지 않습니다.");
    }
    return parsed;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw badRequest("요청 본문을 읽을 수 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.");
  }
}

export function parseCookies(request) {
  const header = request.headers.cookie;
  const cookies = new Map();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!cookies.has(name)) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

export function buildCookie(name, value, { maxAgeSeconds, sameSite = "Lax", secure = false, httpOnly = true, path = "/" } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push("HttpOnly");
  // SameSite=None 은 명세상 Secure 없이는 브라우저가 쿠키를 버립니다.
  if (secure || sameSite === "None") parts.push("Secure");
  if (Number.isFinite(maxAgeSeconds)) {
    parts.push(`Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
    parts.push(`Expires=${new Date(Date.now() + Math.max(0, maxAgeSeconds) * 1000).toUTCString()}`);
  }
  return parts.join("; ");
}

export function expiredCookie(name, options = {}) {
  return buildCookie(name, "", { ...options, maxAgeSeconds: 0 });
}

/** 프록시(IIS 등) 뒤에서도 실제 접속 IP를 알 수 있도록 헤더를 함께 살핍니다. */
export function clientIp(request, { trustProxy = false } = {}) {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    if (forwarded) return String(forwarded).split(",")[0].trim();
  }
  return request.socket?.remoteAddress || "";
}

export function isSecureRequest(request, { trustProxy = false } = {}) {
  if (request.socket?.encrypted) return true;
  if (!trustProxy) return false;
  return String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase() === "https";
}

/** 서로 다른 표기의 오리진 문자열을 비교 가능한 형태로 정리합니다. */
export function normalizeOrigin(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "null") return "";
  try {
    const url = new URL(text.includes("://") ? text : `https://${text}`);
    return `${url.protocol}//${url.host}`.toLowerCase();
  } catch {
    return "";
  }
}
