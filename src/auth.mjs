import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { SSO_SIGNATURE_MODE, USER_ROLE, ROLE_RANK } from "./constants.mjs";
import { badRequest, forbidden, tooManyRequests, unauthorized } from "./errors.mjs";
import { verifyPassword } from "./passwords.mjs";

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCK_MS = 5 * 60 * 1000;
const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

function newToken() {
  return randomBytes(32).toString("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** 세션, 로그인, 아마란스10 메뉴트리 진입(SSO)을 담당합니다. */
export class AuthService {
  constructor({ database, logger }) {
    this.database = database;
    this.logger = logger;
    this.loginAttempts = new Map();
  }

  attemptKey(loginId, ip) {
    return `${String(loginId).toLowerCase()}|${ip}`;
  }

  assertNotLocked(loginId, ip) {
    const entry = this.loginAttempts.get(this.attemptKey(loginId, ip));
    if (!entry) return;
    if (entry.lockedUntil && entry.lockedUntil > Date.now()) {
      const seconds = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
      throw tooManyRequests(`로그인 시도가 많아 잠시 차단되었습니다. ${seconds}초 후에 다시 시도해 주세요.`);
    }
  }

  recordFailure(loginId, ip) {
    const key = this.attemptKey(loginId, ip);
    const entry = this.loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= LOGIN_MAX_ATTEMPTS) {
      entry.lockedUntil = Date.now() + LOGIN_LOCK_MS;
      entry.count = 0;
    }
    this.loginAttempts.set(key, entry);
  }

  clearFailures(loginId, ip) {
    this.loginAttempts.delete(this.attemptKey(loginId, ip));
  }

  createSession(user, { ip, userAgent }) {
    const policy = this.database.getSecuritySettings();
    const now = Date.now();
    const session = {
      id: newToken(),
      csrfToken: newToken(),
      userId: user.id,
      createdAt: new Date(now).toISOString(),
      lastSeenAt: new Date(now).toISOString(),
      absoluteExpiresAt: new Date(now + policy.sessionAbsoluteHours * 3_600_000).toISOString(),
      ip: String(ip || ""),
      userAgent: String(userAgent || "").slice(0, 300),
    };
    this.database.createSession(session);
    return session;
  }

  login(loginId, password, { ip, userAgent }) {
    const normalizedId = String(loginId ?? "").trim();
    if (!normalizedId || !password) throw badRequest("로그인 ID와 비밀번호를 입력해 주세요.");
    this.assertNotLocked(normalizedId, ip);

    const user = this.database.findUserByLoginId(normalizedId);
    const passwordMatches = user?.passwordHash ? verifyPassword(password, user.passwordHash) : false;
    if (!user || !passwordMatches || !user.isActive) {
      this.recordFailure(normalizedId, ip);
      throw unauthorized("로그인 ID 또는 비밀번호가 올바르지 않습니다.");
    }
    this.clearFailures(normalizedId, ip);
    this.database.markUserLoggedIn(user.id);
    return { user: this.database.getUser(user.id), session: this.createSession(user, { ip, userAgent }) };
  }

  /**
   * 세션 쿠키 값으로 현재 사용자를 찾습니다.
   * 유휴 시간(마지막 요청 이후)과 절대 만료 시각을 모두 확인합니다.
   */
  resolveSession(sessionId) {
    if (!sessionId) return null;
    const session = this.database.findSession(sessionId);
    if (!session) return null;
    const now = Date.now();
    const policy = this.database.getSecuritySettings();
    const idleLimit = new Date(session.lastSeenAt).getTime() + policy.sessionIdleMinutes * 60_000;
    if (now > new Date(session.absoluteExpiresAt).getTime() || now > idleLimit) {
      this.database.deleteSession(sessionId);
      return null;
    }
    const user = this.database.getUser(session.userId);
    if (!user || !user.isActive) {
      this.database.deleteSession(sessionId);
      return null;
    }
    // 요청마다 쓰기가 생기지 않도록 마지막 접근 시각은 1분 단위로만 갱신합니다.
    if (now - new Date(session.lastSeenAt).getTime() > SESSION_TOUCH_INTERVAL_MS) {
      this.database.touchSession(sessionId, new Date(now).toISOString());
    }
    return { session, user };
  }

  logout(sessionId) {
    if (sessionId) this.database.deleteSession(sessionId);
  }

  logoutAllForUser(userId) {
    this.database.deleteSessionsForUser(userId);
  }

  /**
   * 아마란스10 메뉴트리에서 넘어온 진입 요청을 검증하고 사용자로 변환합니다.
   * 서명 방식은 아직 확정되지 않았으므로 설정에서 고를 수 있게 했습니다.
   */
  verifySsoRequest(searchParams, { ip }) {
    const settings = this.database.getSsoSettings();
    if (!settings.enabled) throw forbidden("아마란스10 메뉴 진입(SSO)이 꺼져 있습니다. 관리자에게 문의해 주세요.");

    if (settings.allowedIps.length && !settings.allowedIps.some((allowed) => ipMatches(ip, allowed))) {
      this.logger?.warn("허용되지 않은 IP에서 SSO 진입을 시도했습니다.", { ip });
      throw forbidden("허용되지 않은 접속 위치입니다.");
    }
    if (settings.signatureMode === SSO_SIGNATURE_MODE.NONE && settings.allowedIps.length === 0) {
      throw forbidden("서명 검증을 사용하지 않을 때는 허용 IP를 반드시 지정해야 합니다.");
    }

    const loginId = String(searchParams.get(settings.userParam) ?? "").trim();
    if (!loginId) throw badRequest(`메뉴 진입 정보에 사용자 항목(${settings.userParam})이 없습니다.`);

    const timestampValue = settings.timestampParam ? String(searchParams.get(settings.timestampParam) ?? "").trim() : "";
    if (settings.signatureMode !== SSO_SIGNATURE_MODE.NONE) {
      this.verifySsoSignature(searchParams, settings, { loginId, timestampValue });
    }
    if (timestampValue) {
      const seconds = Number(timestampValue.length >= 13 ? Number(timestampValue) / 1000 : Number(timestampValue));
      if (!Number.isFinite(seconds)) throw badRequest("메뉴 진입 정보의 시각 값이 올바르지 않습니다.");
      if (Math.abs(Date.now() / 1000 - seconds) > settings.toleranceSeconds) {
        throw forbidden("메뉴 진입 정보가 만료되었습니다. 아마란스10에서 메뉴를 다시 열어 주세요.");
      }
    }

    const displayName = settings.nameParam ? String(searchParams.get(settings.nameParam) ?? "").trim() : "";
    return { loginId, displayName, settings };
  }

  verifySsoSignature(searchParams, settings, { loginId, timestampValue }) {
    const provided = String(searchParams.get(settings.signatureParam) ?? "").trim();
    if (!provided) throw badRequest(`메뉴 진입 정보에 서명 항목(${settings.signatureParam})이 없습니다.`);

    const hashKey = this.database.getAmaranceSettings().hashKey;
    if (!hashKey) throw forbidden("서명 검증에 필요한 hashKey가 저장되어 있지 않습니다. 아마란스10 설정을 먼저 저장해 주세요.");

    const baseString = settings.signatureMode === SSO_SIGNATURE_MODE.USER_TIMESTAMP
      ? `${loginId}${timestampValue}`
      : sortedParameterString(searchParams, settings.signatureParam);

    const digest = createHmac("sha256", hashKey).update(baseString, "utf8").digest();
    const matches = safeEqual(provided, digest.toString("base64"))
      || safeEqual(provided.toLowerCase(), digest.toString("hex"))
      || safeEqual(provided, digest.toString("base64url"));
    if (!matches) {
      this.logger?.warn("SSO 서명 검증에 실패했습니다.", { loginId, mode: settings.signatureMode });
      throw forbidden("메뉴 진입 정보의 서명이 올바르지 않습니다.");
    }
    // 같은 서명으로 다시 들어오는 것(재전송 공격)을 막습니다.
    if (!this.database.consumeSsoSignature(provided, settings.toleranceSeconds)) {
      throw forbidden("이미 사용된 메뉴 진입 정보입니다. 아마란스10에서 메뉴를 다시 열어 주세요.");
    }
  }

  /** SSO 검증을 통과한 사용자에게 세션을 발급합니다. 필요하면 계정을 자동 생성합니다. */
  establishSsoSession({ loginId, displayName, settings }, { ip, userAgent }) {
    let user = this.database.findUserByLoginId(loginId);
    if (!user) {
      if (!settings.autoCreateUser) {
        throw forbidden(`'${loginId}' 계정이 등록되어 있지 않습니다. 관리자에게 사용자 등록을 요청해 주세요.`);
      }
      const created = this.database.createUser({
        loginId,
        name: displayName || loginId,
        role: settings.defaultRole,
        passwordHash: null,
        origin: "SSO",
      });
      user = this.database.findUserByLoginId(created.loginId);
      this.logger?.info("SSO 진입으로 사용자를 자동 등록했습니다.", { loginId, role: settings.defaultRole });
    }
    if (!user.isActive) throw forbidden("사용 중지된 계정입니다. 관리자에게 문의해 주세요.");
    if (displayName && displayName !== user.name) this.database.updateUserName(user.id, displayName);
    this.database.markUserLoggedIn(user.id);
    return { user: this.database.getUser(user.id), session: this.createSession(user, { ip, userAgent }) };
  }
}

/** 서명 대상 문자열: 서명 항목을 뺀 나머지 파라미터를 key 순으로 정렬해 이어 붙입니다. */
function sortedParameterString(searchParams, signatureParam) {
  return [...searchParams.entries()]
    .filter(([key]) => key !== signatureParam)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

/** 단일 IP 또는 `192.168.1.` 형태의 접두사 표기를 지원합니다. */
export function ipMatches(actual, allowed) {
  const value = String(actual || "").replace(/^::ffff:/, "");
  const rule = String(allowed || "").trim().replace(/^::ffff:/, "");
  if (!rule) return false;
  if (rule === "*") return true;
  if (rule.endsWith(".") || rule.endsWith(":")) return value.startsWith(rule);
  return value === rule;
}

export function hasRole(user, requiredRole) {
  return (ROLE_RANK[user?.role] || 0) >= (ROLE_RANK[requiredRole] || 0);
}

export function assertRole(user, requiredRole) {
  if (!user) throw unauthorized();
  if (!hasRole(user, requiredRole)) {
    throw forbidden(requiredRole === USER_ROLE.ADMIN
      ? "관리자만 사용할 수 있는 기능입니다."
      : "조회 권한만 있어 변경할 수 없습니다. 관리자에게 권한을 요청해 주세요.");
  }
}
