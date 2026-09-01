/**
 * 사용자에게 그대로 보여도 되는 오류.
 * SQLite 원문이나 스택이 화면으로 새어 나가지 않도록, 화면에 노출할 오류는
 * 모두 이 타입으로 만들어 던집니다.
 */
export class AppError extends Error {
  constructor(message, statusCode = 400, code = "BAD_REQUEST") {
    super(message);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.code = code;
    this.expose = true;
  }
}

export function badRequest(message, code = "BAD_REQUEST") {
  return new AppError(message, 400, code);
}

export function unauthorized(message = "로그인이 필요합니다.", code = "UNAUTHORIZED") {
  return new AppError(message, 401, code);
}

export function forbidden(message = "이 작업을 수행할 권한이 없습니다.", code = "FORBIDDEN") {
  return new AppError(message, 403, code);
}

export function notFound(message, code = "NOT_FOUND") {
  return new AppError(message, 404, code);
}

export function conflict(message, code = "CONFLICT") {
  return new AppError(message, 409, code);
}

export function tooManyRequests(message, code = "TOO_MANY_REQUESTS") {
  return new AppError(message, 429, code);
}

export function payloadTooLarge(message = "요청 데이터가 너무 큽니다.") {
  return new AppError(message, 413, "PAYLOAD_TOO_LARGE");
}

/** UNIQUE 제약 위반을 사람이 읽을 수 있는 안내로 바꾸기 위한 표. */
const UNIQUE_CONSTRAINT_MESSAGE = Object.freeze({
  "major_categories.name": "이미 등록된 대분류명입니다. 다른 이름을 사용해 주세요.",
  "major_categories.category_set_id, major_categories.name": "이 설정 버전에 이미 같은 대분류명이 있습니다.",
  "item_mappings.category_set_id, item_mappings.item_code": "이 설정 버전에서 이미 다른 중분류에 연결된 품번입니다. 기존 연결을 먼저 해제해 주세요.",
  "category_sets.version_no": "같은 설정 버전 번호가 이미 있습니다. 다시 시도해 주세요.",
  "middle_categories.major_category_id, middle_categories.name": "같은 대분류 안에 이미 같은 중분류명이 있습니다.",
  "item_mappings.item_code": "이미 다른 중분류에 연결된 품번입니다. 기존 연결을 먼저 해제해 주세요.",
  "projects.code": "이미 등록된 프로젝트코드입니다.",
  "snapshots.project_id, snapshots.version_no": "같은 버전 번호가 이미 있습니다. 잠시 후 다시 시도해 주세요.",
  "snapshot_items.snapshot_line_id, snapshot_items.item_code": "이 중분류에 같은 품번이 이미 있습니다.",
  "receipts.snapshot_id, receipts.source_key": "이미 반영된 입고 내역입니다.",
  "users.login_id": "이미 등록된 로그인 ID입니다.",
  "app_settings.setting_key": "설정을 저장하는 중 충돌이 발생했습니다. 다시 시도해 주세요.",
});

const FOREIGN_KEY_MESSAGE = "연결된 상위 항목을 찾을 수 없습니다. 화면을 새로 고친 뒤 다시 시도해 주세요.";

/**
 * SQLite 드라이버 오류를 화면에 띄울 수 있는 한국어 AppError 로 바꿉니다.
 * 대응표에 없는 오류는 절대 원문을 노출하지 않고 일반 메시지로 감쌉니다.
 */
export function translateDatabaseError(error) {
  if (error instanceof AppError) return error;
  const raw = String(error?.message ?? "");

  const uniqueMatch = raw.match(/UNIQUE constraint failed:\s*(.+)$/i);
  if (uniqueMatch) {
    const columns = uniqueMatch[1].trim();
    return conflict(UNIQUE_CONSTRAINT_MESSAGE[columns] || "이미 같은 값이 등록되어 있습니다.", "DUPLICATE");
  }
  if (/FOREIGN KEY constraint failed/i.test(raw)) {
    return badRequest(FOREIGN_KEY_MESSAGE, "FOREIGN_KEY");
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return badRequest("필수 값이 비어 있습니다. 입력 내용을 확인해 주세요.", "NOT_NULL");
  }
  if (/CHECK constraint failed/i.test(raw)) {
    return badRequest("입력값이 허용된 범위를 벗어났습니다.", "CHECK");
  }
  if (/database is locked|SQLITE_BUSY/i.test(raw)) {
    return conflict("다른 사용자가 같은 자료를 저장하는 중입니다. 잠시 후 다시 시도해 주세요.", "BUSY");
  }
  if (/readonly database|attempt to write a readonly/i.test(raw)) {
    return new AppError("데이터베이스가 읽기 전용 상태입니다. 관리자에게 문의해 주세요.", 500, "READONLY");
  }
  return null;
}

/**
 * 응답으로 내보낼 상태코드와 메시지를 결정합니다.
 * 화면 노출이 허용되지 않은 오류는 일반 메시지로 바꾸고, 원문은 로그에만 남깁니다.
 */
export function describeError(error) {
  if (error instanceof AppError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message, internal: false };
  }
  const translated = translateDatabaseError(error);
  if (translated) {
    return { statusCode: translated.statusCode, code: translated.code, message: translated.message, internal: false };
  }
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "처리 중 오류가 발생했습니다. 문제가 계속되면 관리자에게 문의해 주세요.",
    internal: true,
  };
}
