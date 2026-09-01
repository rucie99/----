import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const SCRYPT_OPTIONS = Object.freeze({ N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const KEY_BYTES = 64;
const SALT_BYTES = 16;
const PREFIX = "scrypt";

/** 사람이 옮겨 적기 쉬우면서 헷갈리는 글자(0/O, 1/l/I)는 뺀 문자 집합. */
const READABLE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function hashPassword(password) {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(String(password), salt, KEY_BYTES, SCRYPT_OPTIONS);
  return `${PREFIX}:${SCRYPT_OPTIONS.N}:${SCRYPT_OPTIONS.r}:${SCRYPT_OPTIONS.p}:${salt.toString("base64")}:${derived.toString("base64")}`;
}

export function verifyPassword(password, storedHash) {
  const parts = String(storedHash ?? "").split(":");
  if (parts.length !== 6 || parts[0] !== PREFIX) return false;
  const [, n, r, p, saltPart, hashPart] = parts;
  try {
    const expected = Buffer.from(hashPart, "base64");
    const derived = scryptSync(String(password), Buffer.from(saltPart, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT_OPTIONS.maxmem,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function generateReadablePassword(length = 14) {
  const bytes = randomBytes(length);
  let password = "";
  for (let index = 0; index < length; index += 1) {
    password += READABLE_ALPHABET[bytes[index] % READABLE_ALPHABET.length];
  }
  return password;
}

/**
 * 비밀번호 규칙 검사. 사내 공용 PC 환경을 감안해
 * 길이를 우선하고 문자 종류는 두 가지 이상만 요구합니다.
 */
export function assertPasswordPolicy(password) {
  const value = String(password ?? "");
  if (value.length < 10) throw new Error("비밀번호는 10자 이상이어야 합니다.");
  if (value.length > 200) throw new Error("비밀번호가 너무 깁니다.");
  if (/\s/.test(value)) throw new Error("비밀번호에 공백은 사용할 수 없습니다.");
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  if (kinds < 2) throw new Error("비밀번호는 영문, 숫자, 기호 중 두 종류 이상을 섞어 주세요.");
  return value;
}
