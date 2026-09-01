export const APP_NAME = "경기산업 기성집행서";
export const DEFAULT_PORT = 5080;
export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_DB_PATH = "data/progress-statement.db";

export const SNAPSHOT_STATUS = Object.freeze({
  DRAFT: "DRAFT",
  CONFIRMED: "CONFIRMED",
});

export const PROJECT_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  COMPLETE: "COMPLETE",
  UNUSED: "UNUSED",
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

export const AMARANCE_AUTH_HEADER = Object.freeze({
  CALLER_NAME: "callerName",
  AUTHORIZATION: "Authorization",
  TRANSACTION_ID: "transaction-id",
  TIMESTAMP: "timestamp",
  GROUP_SEQ: "groupSeq",
  SIGNATURE: "wehago-sign",
});

export const CONTENT_TYPE = Object.freeze({
  JSON: "application/json; charset=utf-8",
  HTML: "text/html; charset=utf-8",
  CSS: "text/css; charset=utf-8",
  JAVASCRIPT: "text/javascript; charset=utf-8",
  SVG: "image/svg+xml",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

export const MAX_REQUEST_BYTES = 1_048_576;
