import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const PREFIX = "enc:v1:";
const IV_BYTES = 12;
const KEY_BYTES = 32;

function decodeKey(value) {
  const key = Buffer.from(String(value).trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error("APP_SECRET_KEY는 base64로 인코딩한 32바이트 키여야 합니다.");
  }
  return key;
}

/**
 * 저장 시 암호화가 필요한 값(accessToken, hashKey)을 다루는 금고.
 *
 * 키는 환경변수 APP_SECRET_KEY 를 우선 사용하고, 없으면 data/secret.key 를 만들어 씁니다.
 * DB 파일만 유출되어도 자격증명이 그대로 노출되지 않게 하는 것이 목적이므로,
 * 키 파일은 반드시 DB와 다른 위치에 백업하거나 별도 권한으로 보호해야 합니다.
 */
export class SecretVault {
  constructor({ key, keyPath, logger } = {}) {
    this.logger = logger;
    if (key) {
      this.key = decodeKey(key);
      this.source = "env";
      return;
    }
    if (!keyPath) throw new Error("암호화 키 경로가 필요합니다.");
    this.keyPath = resolve(keyPath);
    this.key = this.loadOrCreateKey();
    this.source = "file";
  }

  loadOrCreateKey() {
    if (existsSync(this.keyPath)) {
      return decodeKey(readFileSync(this.keyPath, "utf8"));
    }
    mkdirSync(dirname(this.keyPath), { recursive: true });
    const key = randomBytes(KEY_BYTES);
    writeFileSync(this.keyPath, key.toString("base64"), { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(this.keyPath, 0o600);
    } catch {
      /* Windows에서는 chmod가 제한적으로 동작합니다. NTFS 권한은 설치 스크립트에서 조정합니다. */
    }
    this.logger?.warn("암호화 키를 새로 생성했습니다. DB 백업과 별도로 안전하게 보관하세요.", { keyPath: this.keyPath });
    return key;
  }

  isEncrypted(value) {
    return typeof value === "string" && value.startsWith(PREFIX);
  }

  encrypt(plainText) {
    const text = String(plainText ?? "");
    if (!text) return "";
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
  }

  /**
   * 복호화합니다. 평문(구버전 데이터)이 들어오면 그대로 돌려주어
   * 암호화 도입 이전에 저장된 값도 계속 읽을 수 있게 합니다.
   */
  decrypt(storedValue) {
    const value = String(storedValue ?? "");
    if (!value) return "";
    if (!this.isEncrypted(value)) return value;
    const [, , ivPart, tagPart, dataPart] = value.split(":");
    try {
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64"));
      decipher.setAuthTag(Buffer.from(tagPart, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
    } catch (error) {
      this.logger?.error("저장된 자격증명을 복호화하지 못했습니다. 암호화 키가 바뀌었는지 확인하세요.", { error });
      return "";
    }
  }
}
