export const APP_NAME = "경기산업 기성집행서";
export const DEFAULT_PORT = 5080;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_DB_PATH = "data/progress-statement.db";
export const DEFAULT_LOG_DIRECTORY = "data/logs";
export const DEFAULT_SECRET_KEY_PATH = "data/secret.key";

export const SNAPSHOT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  CONFIRMED: "CONFIRMED",
});

export const PROJECT_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETE: "COMPLETE",
  UNUSED: "UNUSED",
});

export const USER_ROLE = Object.freeze({
  ADMIN: "ADMIN",
  EDITOR: "EDITOR",
  VIEWER: "VIEWER",
});

export const USER_ROLE_LABEL = Object.freeze({
  ADMIN: "관리자",
  EDITOR: "작성자",
  VIEWER: "조회자",
});

/** 역할별 권한 등급. 숫자가 클수록 더 많은 일을 할 수 있습니다. */
export const ROLE_RANK = Object.freeze({
  VIEWER: 1,
  EDITOR: 2,
  ADMIN: 3,
});

export const AMARANCE_MODE = Object.freeze({
  DEMO: "DEMO",
  LIVE: "LIVE",
});

export const AMARANCE_API_PATH = Object.freeze({
  PROJECT_SEARCH: "/apiproxy/api16S15",
  ITEM_SEARCH: "/apiproxy/api20A00S00701",
  RECEIPT_HEADER_SEARCH: "/apiproxy/api20A02S00201",
  RECEIPT_DETAIL_SEARCH: "/apiproxy/api20A02S00202",
});

export const AMARANCE_SETTING_KEY = Object.freeze({
  MODE: "AMARANTH_MODE",
  BASE_URL: "AMARANTH_BASE_URL",
  COMPANY_CODE: "AMARANTH_COMPANY_CODE",
  CALLER_NAME: "AMARANTH_CALLER_NAME",
  ACCESS_TOKEN: "AMARANTH_ACCESS_TOKEN",
  HASH_KEY: "AMARANTH_HASH_KEY",
  GROUP_SEQ: "AMARANTH_GROUP_SEQ",
});

/** 값이 암호화되어 저장되는 설정 키. */
export const ENCRYPTED_SETTING_KEYS = Object.freeze([
  AMARANCE_SETTING_KEY.ACCESS_TOKEN,
  AMARANCE_SETTING_KEY.HASH_KEY,
]);

export const AMARANCE_AUTH_HEADER = Object.freeze({
  CALLER_NAME: "callerName",
  AUTHORIZATION: "Authorization",
  TRANSACTION_ID: "transaction-id",
  TIMESTAMP: "timestamp",
  GROUP_SEQ: "groupSeq",
  SIGNATURE: "wehago-sign",
});

/**
 * 아마란스10 메뉴트리 진입(SSO) 서명 방식.
 * 아마란스10이 실제로 어떤 형태로 서명을 전달하는지 확인되기 전까지
 * 세 가지 방식을 화면에서 선택할 수 있게 둡니다.
 */
export const SSO_SIGNATURE_MODE = Object.freeze({
  /** 정렬한 전체 파라미터를 key=value&... 로 이어 HMAC-SHA256 서명 검증 */
  PARAMS_SORTED: "PARAMS_SORTED",
  /** 사용자ID + timestamp 를 이어 HMAC-SHA256 서명 검증 (wehago-sign 방식과 동일 계열) */
  USER_TIMESTAMP: "USER_TIMESTAMP",
  /** 서명을 검증하지 않음. 반드시 허용 IP 목록과 함께 사용해야 합니다. */
  NONE: "NONE",
});

export const SSO_SETTING_KEY = Object.freeze({
  ENABLED: "SSO_ENABLED",
  SIGNATURE_MODE: "SSO_SIGNATURE_MODE",
  USER_PARAM: "SSO_USER_PARAM",
  NAME_PARAM: "SSO_NAME_PARAM",
  TIMESTAMP_PARAM: "SSO_TIMESTAMP_PARAM",
  SIGNATURE_PARAM: "SSO_SIGNATURE_PARAM",
  ALLOWED_IPS: "SSO_ALLOWED_IPS",
  AUTO_CREATE_USER: "SSO_AUTO_CREATE_USER",
  DEFAULT_ROLE: "SSO_DEFAULT_ROLE",
  TOLERANCE_SECONDS: "SSO_TOLERANCE_SECONDS",
});

export const SECURITY_SETTING_KEY = Object.freeze({
  FRAME_ANCESTORS: "SECURITY_FRAME_ANCESTORS",
  COOKIE_SAMESITE: "SECURITY_COOKIE_SAMESITE",
  COOKIE_SECURE: "SECURITY_COOKIE_SECURE",
  SESSION_IDLE_MINUTES: "SECURITY_SESSION_IDLE_MINUTES",
  SESSION_ABSOLUTE_HOURS: "SECURITY_SESSION_ABSOLUTE_HOURS",
  RECEIPT_MAX_RANGE_DAYS: "SECURITY_RECEIPT_MAX_RANGE_DAYS",
  TRUST_PROXY: "SECURITY_TRUST_PROXY",
});

export const COOKIE_SAMESITE = Object.freeze({
  LAX: "Lax",
  NONE: "None",
  STRICT: "Strict",
});

export const SESSION_COOKIE_NAME = "gi_session";
export const CSRF_HEADER_NAME = "x-csrf-token";

export const AUDIT_ACTION = Object.freeze({
  LOGIN: "LOGIN",
  LOGIN_SSO: "LOGIN_SSO",
  LOGIN_FAILED: "LOGIN_FAILED",
  LOGOUT: "LOGOUT",
  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  USER_CREATED: "USER_CREATED",
  USER_UPDATED: "USER_UPDATED",
  USER_DELETED: "USER_DELETED",
  CATEGORY_CHANGED: "CATEGORY_CHANGED",
  PROJECT_SYNCED: "PROJECT_SYNCED",
  SNAPSHOT_CREATED: "SNAPSHOT_CREATED",
  SNAPSHOT_UPDATED: "SNAPSHOT_UPDATED",
  SNAPSHOT_CONFIRMED: "SNAPSHOT_CONFIRMED",
  SNAPSHOT_DELETED: "SNAPSHOT_DELETED",
  SNAPSHOT_RENAMED: "SNAPSHOT_RENAMED",
  CONTRACT_REFRESHED: "CONTRACT_REFRESHED",
  RECEIPTS_IMPORTED: "RECEIPTS_IMPORTED",
  RECEIPTS_DELETED: "RECEIPTS_DELETED",
  AMARANCE_SETTINGS_SAVED: "AMARANCE_SETTINGS_SAVED",
  SECURITY_SETTINGS_SAVED: "SECURITY_SETTINGS_SAVED",
  EXPORTED: "EXPORTED",
  CATEGORY_SET_CREATED: "CATEGORY_SET_CREATED",
  CATEGORY_SET_RENAMED: "CATEGORY_SET_RENAMED",
  CATEGORY_SET_ACTIVATED: "CATEGORY_SET_ACTIVATED",
  CATEGORY_SET_DELETED: "CATEGORY_SET_DELETED",
  DATA_RESET: "DATA_RESET",
});

export const CONTENT_TYPE = Object.freeze({
  JSON: "application/json; charset=utf-8",
  HTML: "text/html; charset=utf-8",
  CSS: "text/css; charset=utf-8",
  JAVASCRIPT: "text/javascript; charset=utf-8",
  SVG: "image/svg+xml",
  ICON: "image/x-icon",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

export const MAX_REQUEST_BYTES = 1_048_576;
/** 입고 헤더 조회 결과가 이 건수를 넘으면 기간을 좁히도록 안내합니다. */
export const MAX_RECEIPT_HEADERS = 2_000;
/** 품번 검색 결과 표시 상한. */
export const MAX_ITEM_SEARCH_RESULTS = 200;
export const DEFAULT_RECEIPT_MAX_RANGE_DAYS = 366;
export const DEFAULT_SESSION_IDLE_MINUTES = 480;
export const DEFAULT_SESSION_ABSOLUTE_HOURS = 12;
export const DEFAULT_SSO_TOLERANCE_SECONDS = 300;
export const BOOTSTRAP_ADMIN_LOGIN_ID = "admin";
/** 초기화를 실행하려면 사용자가 이 문구를 그대로 입력해야 합니다. */
export const RESET_CONFIRM_PHRASE = "모두 초기화";
