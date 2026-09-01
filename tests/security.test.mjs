import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { SecretVault } from "../src/secrets.mjs";
import { assertPasswordPolicy, generateReadablePassword, hashPassword, verifyPassword } from "../src/passwords.mjs";
import { describeError, translateDatabaseError, AppError } from "../src/errors.mjs";
import { ipMatches } from "../src/auth.mjs";
import { AppDatabase } from "../src/database.mjs";
import { AMARANCE_SETTING_KEY } from "../src/constants.mjs";

function newVault() {
  return new SecretVault({ key: randomBytes(32).toString("base64") });
}

test("자격증명을 암호화해 저장하고 원문을 복원한다", () => {
  const vault = newVault();
  const encrypted = vault.encrypt("ACCESS_TOKEN_원문");
  assert.notEqual(encrypted, "ACCESS_TOKEN_원문");
  assert.ok(encrypted.startsWith("enc:v1:"));
  assert.equal(vault.decrypt(encrypted), "ACCESS_TOKEN_원문");
  assert.equal(vault.encrypt(""), "");
});

test("암호화 이전에 저장된 평문 값도 그대로 읽는다", () => {
  const vault = newVault();
  assert.equal(vault.decrypt("이전에_저장된_평문"), "이전에_저장된_평문");
});

test("다른 키로는 복호화되지 않는다", () => {
  const encrypted = newVault().encrypt("비밀값");
  assert.equal(newVault().decrypt(encrypted), "");
});

test("accessToken과 hashKey는 DB에 평문으로 남지 않는다", () => {
  const database = new AppDatabase({ path: ":memory:", secretVault: newVault() });
  database.saveAmaranceSettings({
    mode: "LIVE",
    baseUrl: "https://erp.example.com",
    companyCode: "1000",
    callerName: "CALLER",
    accessToken: "PLAIN_ACCESS_TOKEN",
    hashKey: "PLAIN_HASH_KEY",
    groupSeq: "GROUP",
  });

  const stored = database.db.prepare("SELECT setting_key AS k, setting_value AS v FROM app_settings").all();
  const raw = new Map(stored.map((row) => [row.k, row.v]));
  assert.notEqual(raw.get(AMARANCE_SETTING_KEY.ACCESS_TOKEN), "PLAIN_ACCESS_TOKEN");
  assert.notEqual(raw.get(AMARANCE_SETTING_KEY.HASH_KEY), "PLAIN_HASH_KEY");
  assert.ok(raw.get(AMARANCE_SETTING_KEY.ACCESS_TOKEN).startsWith("enc:v1:"));
  // 회사코드처럼 비밀이 아닌 값은 그대로 둡니다.
  assert.equal(raw.get(AMARANCE_SETTING_KEY.COMPANY_CODE), "1000");

  const settings = database.getAmaranceSettings();
  assert.equal(settings.accessToken, "PLAIN_ACCESS_TOKEN");
  assert.equal(settings.hashKey, "PLAIN_HASH_KEY");
  database.close();
});

test("비밀번호는 해시로만 저장되고 같은 값도 매번 다르게 해시된다", () => {
  const first = hashPassword("Test!password1");
  const second = hashPassword("Test!password1");
  assert.notEqual(first, second);
  assert.ok(verifyPassword("Test!password1", first));
  assert.ok(verifyPassword("Test!password1", second));
  assert.equal(verifyPassword("틀린비밀번호", first), false);
  assert.equal(verifyPassword("Test!password1", "손상된해시"), false);
});

test("비밀번호 규칙은 길이와 문자 종류를 함께 본다", () => {
  assert.throws(() => assertPasswordPolicy("짧다"), /10자 이상/);
  assert.throws(() => assertPasswordPolicy("aaaaaaaaaaaa"), /두 종류 이상/);
  assert.throws(() => assertPasswordPolicy("abc 12345678"), /공백/);
  assert.equal(assertPasswordPolicy("Abcdef12345"), "Abcdef12345");
});

test("임시 비밀번호는 헷갈리는 글자를 쓰지 않는다", () => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const password = generateReadablePassword(14);
    assert.equal(password.length, 14);
    assert.doesNotMatch(password, /[0O1lI]/);
  }
});

test("SQLite 오류는 한국어 안내로 바뀌고 원문이 새지 않는다", () => {
  const unique = translateDatabaseError(new Error("UNIQUE constraint failed: item_mappings.item_code"));
  assert.equal(unique.statusCode, 409);
  assert.match(unique.message, /이미 다른 중분류에 연결된 품번/);

  const foreignKey = translateDatabaseError(new Error("FOREIGN KEY constraint failed"));
  assert.equal(foreignKey.statusCode, 400);

  const unknownUnique = translateDatabaseError(new Error("UNIQUE constraint failed: some_table.some_column"));
  assert.match(unknownUnique.message, /이미 같은 값이 등록되어 있습니다/);

  assert.equal(translateDatabaseError(new Error("정체불명 오류")), null);
});

test("정체불명 오류는 500으로 감싸고 원문을 화면에 내보내지 않는다", () => {
  const described = describeError(new Error("ENOENT: no such file or directory, open 'C:\\\\secret'"));
  assert.equal(described.statusCode, 500);
  assert.equal(described.internal, true);
  assert.doesNotMatch(described.message, /ENOENT|secret/);

  const appError = describeError(new AppError("사용자에게 보여도 되는 안내", 400, "BAD"));
  assert.equal(appError.message, "사용자에게 보여도 되는 안내");
  assert.equal(appError.internal, false);
});

test("허용 IP는 단일 주소와 접두사 표기를 모두 지원한다", () => {
  assert.ok(ipMatches("10.0.1.5", "10.0.1.5"));
  assert.ok(ipMatches("::ffff:10.0.1.5", "10.0.1.5"));
  assert.ok(ipMatches("192.168.10.44", "192.168.10."));
  assert.equal(ipMatches("192.168.11.44", "192.168.10."), false);
  assert.equal(ipMatches("10.0.1.5", ""), false);
  assert.ok(ipMatches("아무주소", "*"));
});
