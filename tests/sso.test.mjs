import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { createClient, loginAsAdmin, startTestServer } from "./helpers/server.mjs";

const HASH_KEY = "SSO_HASH_KEY_TEST";

/** 관리자로 아마란스10 hashKey와 SSO 설정을 저장합니다. */
async function configureSso(server, sso) {
  await loginAsAdmin(server);
  const saved = await server.client.request("/api/amarance/settings", {
    method: "PUT",
    body: {
      mode: "DEMO",
      baseUrl: "https://erp.example.com",
      companyCode: "1000",
      callerName: "CALLER",
      groupSeq: "GROUP",
      accessToken: "ACCESS",
      hashKey: HASH_KEY,
    },
  });
  assert.equal(saved.status, 200);

  const result = await server.client.request("/api/security/settings", {
    method: "PUT",
    body: {
      sso: {
        enabled: true,
        signatureMode: "USER_TIMESTAMP",
        userParam: "userId",
        nameParam: "userNm",
        timestampParam: "timestamp",
        signatureParam: "sign",
        allowedIps: "",
        autoCreateUser: true,
        defaultRole: "EDITOR",
        toleranceSeconds: 300,
        ...sso,
      },
      security: {
        frameAncestors: "",
        cookieSameSite: "Lax",
        cookieSecure: false,
        trustProxy: false,
        sessionIdleMinutes: 60,
        sessionAbsoluteHours: 8,
        receiptMaxRangeDays: 366,
      },
    },
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return result.data;
}

function ssoUrl({ userId, userNm = "홍길동", timestamp = Math.floor(Date.now() / 1000), sign }) {
  const signature = sign ?? createHmac("sha256", HASH_KEY).update(`${userId}${timestamp}`, "utf8").digest("base64");
  const parameters = new URLSearchParams({ userId, userNm, timestamp: String(timestamp), sign: signature });
  return `/sso?${parameters}`;
}

test("서명이 맞는 아마란스10 메뉴 진입은 세션을 발급하고 사용자를 자동 등록한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server);

  const visitor = createClient(server.origin);
  const entry = await visitor.request(ssoUrl({ userId: "10231" }));
  assert.equal(entry.status, 302);
  assert.equal(entry.response.headers.get("location"), "/");

  const session = await visitor.request("/api/session");
  assert.equal(session.status, 200);
  assert.equal(session.data.authenticated, true);
  assert.equal(session.data.user.loginId, "10231");
  assert.equal(session.data.user.name, "홍길동");
  assert.equal(session.data.user.role, "EDITOR");
  assert.equal(session.data.user.origin, "SSO");

  // SSO 로그인은 임시 비밀번호 절차 없이 바로 사용할 수 있어야 합니다.
  const bootstrap = await visitor.request("/api/bootstrap");
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.data.permissions.canEdit, true);
});

test("서명이 틀리거나 시각이 오래되면 진입을 거부한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server);

  const badSignature = await createClient(server.origin).request(ssoUrl({ userId: "10232", sign: "WRONG" }));
  assert.equal(badSignature.status, 403);
  assert.match(badSignature.data.message, /서명/);

  const expired = await createClient(server.origin).request(
    ssoUrl({ userId: "10233", timestamp: Math.floor(Date.now() / 1000) - 4000 }),
  );
  assert.equal(expired.status, 403);
  assert.match(expired.data.message, /만료/);
});

test("같은 서명으로 두 번 들어오는 재전송은 막는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server);

  const url = ssoUrl({ userId: "10234" });
  const first = await createClient(server.origin).request(url);
  assert.equal(first.status, 302);

  const replay = await createClient(server.origin).request(url);
  assert.equal(replay.status, 403);
  assert.match(replay.data.message, /이미 사용된/);
});

test("자동 등록을 끄면 미등록 사용자의 진입을 막는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server, { autoCreateUser: false });

  const denied = await createClient(server.origin).request(ssoUrl({ userId: "99999" }));
  assert.equal(denied.status, 403);
  assert.match(denied.data.message, /등록되어 있지 않습니다/);
});

test("허용 IP를 벗어난 진입은 막는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server, { allowedIps: "10.9.9.9" });

  const denied = await createClient(server.origin).request(ssoUrl({ userId: "10235" }));
  assert.equal(denied.status, 403);
  assert.match(denied.data.message, /접속 위치/);
});

test("서명 검증을 끄면서 허용 IP를 비우면 설정 저장 자체를 거부한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const rejected = await server.client.request("/api/security/settings", {
    method: "PUT",
    body: {
      sso: { enabled: true, signatureMode: "NONE", userParam: "userId", allowedIps: "" },
      security: {},
    },
  });
  assert.equal(rejected.status, 400);
  assert.match(rejected.data.message, /허용 IP/);
});

test("SSO를 꺼 두면 진입 주소가 동작하지 않는다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await loginAsAdmin(server);

  const denied = await createClient(server.origin).request(ssoUrl({ userId: "10236" }));
  assert.equal(denied.status, 403);
  assert.match(denied.data.message, /꺼져 있습니다/);
});

test("전체 파라미터 정렬 방식의 서명도 검증한다", async (t) => {
  const server = await startTestServer();
  t.after(() => server.stop());
  await configureSso(server, { signatureMode: "PARAMS_SORTED" });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const values = { timestamp, userId: "10240", userNm: "김철수" };
  const baseString = Object.keys(values).sort().map((key) => `${key}=${values[key]}`).join("&");
  const sign = createHmac("sha256", HASH_KEY).update(baseString, "utf8").digest("base64");
  const parameters = new URLSearchParams({ ...values, sign });

  const entry = await createClient(server.origin).request(`/sso?${parameters}`);
  assert.equal(entry.status, 302);
});
