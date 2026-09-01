import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import { calculateBudget, calculateSummary, toWon } from "./calculations.mjs";
import {
  AMARANCE_MODE,
  AMARANCE_SETTING_KEY,
  AUDIT_ACTION,
  BOOTSTRAP_ADMIN_LOGIN_ID,
  COOKIE_SAMESITE,
  DEFAULT_RECEIPT_MAX_RANGE_DAYS,
  DEFAULT_SESSION_ABSOLUTE_HOURS,
  DEFAULT_SESSION_IDLE_MINUTES,
  DEFAULT_SSO_TOLERANCE_SECONDS,
  ENCRYPTED_SETTING_KEYS,
  PROJECT_STATUS,
  SECURITY_SETTING_KEY,
  SNAPSHOT_STATUS,
  SSO_SETTING_KEY,
  SSO_SIGNATURE_MODE,
  USER_ROLE,
} from "./constants.mjs";
import { badRequest, conflict, notFound } from "./errors.mjs";
import { generateReadablePassword, hashPassword } from "./passwords.mjs";
import { SecretVault } from "./secrets.mjs";
import { silentLogger } from "./logger.mjs";

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value, fieldName, maxLength = 200) {
  const normalized = String(value ?? "").trim();
  if (!normalized) throw badRequest(`${fieldName}을(를) 입력해 주세요.`);
  if (normalized.length > maxLength) throw badRequest(`${fieldName}은(는) ${maxLength}자 이내로 입력해 주세요.`);
  return normalized;
}

function positiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`${fieldName}이(가) 올바르지 않습니다.`);
  return parsed;
}

function booleanText(value) {
  return value ? "1" : "0";
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "y", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function boundedNumber(value, fallback, min, max) {
  // Number("")는 0이므로, 비어 있는 설정값이 최솟값으로 눌리지 않게 먼저 걸러 냅니다.
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

export class AppDatabase {
  /**
   * @param {string|{path:string, secretVault?:SecretVault, logger?:object}} options
   */
  constructor(options) {
    const settings = typeof options === "string" ? { path: options } : (options || {});
    const databasePath = settings.path;
    this.logger = settings.logger || silentLogger;
    const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (resolvedPath !== ":memory:") mkdirSync(dirname(resolvedPath), { recursive: true });

    // 금고가 주어지지 않으면(테스트 등) 프로세스 수명 동안만 유효한 임시 키를 씁니다.
    this.secretVault = settings.secretVault
      || new SecretVault({ key: randomBytes(32).toString("base64"), logger: this.logger });

    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  initialize() {
    this.createTables();
    this.migrate();
    this.ensureCurrentCategorySet();
    this.seedDemoData();
  }

  createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS category_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_no INTEGER NOT NULL UNIQUE,
        title TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS major_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_set_id INTEGER NOT NULL REFERENCES category_sets(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(category_set_id, name)
      );
      CREATE TABLE IF NOT EXISTS app_settings (
        setting_key TEXT PRIMARY KEY,
        setting_value TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS middle_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        major_category_id INTEGER NOT NULL REFERENCES major_categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        UNIQUE(major_category_id, name)
      );
      CREATE TABLE IF NOT EXISTS item_mappings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category_set_id INTEGER NOT NULL REFERENCES category_sets(id) ON DELETE CASCADE,
        middle_category_id INTEGER NOT NULL REFERENCES middle_categories(id) ON DELETE CASCADE,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        UNIQUE(category_set_id, item_code)
      );
      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        contract_amount INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT '${PROJECT_STATUS.ACTIVE}',
        synced_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '${SNAPSHOT_STATUS.DRAFT}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id, version_no)
      );
      CREATE TABLE IF NOT EXISTS snapshot_lines (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        major_name TEXT NOT NULL,
        middle_name TEXT NOT NULL,
        major_sort INTEGER NOT NULL,
        middle_sort INTEGER NOT NULL,
        execution_budget INTEGER NOT NULL DEFAULT 0,
        remark TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS snapshot_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_line_id INTEGER NOT NULL REFERENCES snapshot_lines(id) ON DELETE CASCADE,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        UNIQUE(snapshot_line_id, item_code)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        source_key TEXT NOT NULL,
        receipt_no TEXT NOT NULL,
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        receipt_date TEXT NOT NULL,
        amount INTEGER NOT NULL DEFAULT 0,
        vat_amount INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT NOT NULL,
        UNIQUE(snapshot_id, source_key)
      );
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        login_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '${USER_ROLE.VIEWER}',
        password_hash TEXT,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        origin TEXT NOT NULL DEFAULT 'LOCAL',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_login_at TEXT
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        absolute_expires_at TEXT NOT NULL,
        ip TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS sso_nonces (
        signature TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id INTEGER,
        login_id TEXT NOT NULL DEFAULT '',
        user_name TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL,
        target_type TEXT NOT NULL DEFAULT '',
        target_id TEXT NOT NULL DEFAULT '',
        detail TEXT NOT NULL DEFAULT '',
        ip TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_snapshot_lines_snapshot ON snapshot_lines(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_snapshot_items_line ON snapshot_items(snapshot_line_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_snapshot_item ON receipts(snapshot_id, item_code);
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
    `);
  }

  columnNames(tableName) {
    return new Set(this.db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => row.name));
  }

  /** 기존 설치본의 DB를 새 스키마로 올립니다. 데이터는 보존합니다. */
  migrate() {
    const snapshotColumns = this.columnNames("snapshots");
    if (!snapshotColumns.has("contract_amount")) {
      // 확정 버전의 금액이 프로젝트 동기화로 바뀌지 않도록 스냅샷에 계약금액을 고정 보관합니다.
      this.db.exec("ALTER TABLE snapshots ADD COLUMN contract_amount INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE snapshots SET contract_amount =
          COALESCE((SELECT p.contract_amount FROM projects p WHERE p.id = snapshots.project_id), 0)
      `);
      const filled = Number(this.db.prepare("SELECT COUNT(*) AS count FROM snapshots").get().count);
      if (filled > 0) this.logger.info(`기존 집행서 ${filled}건에 계약금액을 고정 보관하도록 옮겼습니다.`);
    }
    if (!snapshotColumns.has("created_by")) {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN created_by TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE snapshots ADD COLUMN confirmed_by TEXT NOT NULL DEFAULT ''");
      this.db.exec("ALTER TABLE snapshots ADD COLUMN confirmed_at TEXT");
    }
    if (!snapshotColumns.has("revision")) {
      // 저장 시각(밀리초)만으로는 같은 순간의 두 저장을 구분하지 못하므로
      // 변경할 때마다 1씩 올라가는 수정 회차로 동시 편집을 판별합니다.
      this.db.exec("ALTER TABLE snapshots ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
    }

    // 분류·품번 설정을 버전(세트)으로 분리합니다.
    // SQLite 는 UNIQUE 제약을 바꿀 수 없어 테이블을 다시 만들어 옮깁니다.
    if (!this.columnNames("major_categories").has("category_set_id")) {
      this.migrateCategorySets();
    }
    const snapshotColumnsForSet = this.columnNames("snapshots");
    if (!snapshotColumnsForSet.has("category_set_id")) {
      this.db.exec("ALTER TABLE snapshots ADD COLUMN category_set_id INTEGER");
      // 세트가 지워져도 어느 설정에서 나왔는지 남도록 이름을 함께 보관합니다.
      this.db.exec("ALTER TABLE snapshots ADD COLUMN category_set_label TEXT NOT NULL DEFAULT ''");
      const first = this.db.prepare("SELECT id, version_no AS versionNo, title FROM category_sets ORDER BY version_no LIMIT 1").get();
      if (first) {
        this.db.prepare("UPDATE snapshots SET category_set_id = ?, category_set_label = ?")
          .run(first.id, `v${first.versionNo} · ${first.title}`);
      }
    }

    if (!this.columnNames("projects").has("is_archived")) {
      // 아마란스10 조회 결과에서 사라진 프로젝트를 표시합니다.
      // 집행서가 달린 프로젝트는 지우면 확정본까지 연쇄 삭제되므로 보관 표시만 합니다.
      this.db.exec("ALTER TABLE projects ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0");
    }

    const itemColumns = this.columnNames("snapshot_items");
    if (!itemColumns.has("snapshot_id")) {
      // 같은 품번이 한 스냅샷의 두 중분류에 붙으면 매입금액이 이중 집계됩니다.
      // snapshot_id 를 비정규화해 UNIQUE 로 구조적으로 막습니다.
      this.db.exec("ALTER TABLE snapshot_items ADD COLUMN snapshot_id INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`
        UPDATE snapshot_items SET snapshot_id =
          COALESCE((SELECT sl.snapshot_id FROM snapshot_lines sl WHERE sl.id = snapshot_items.snapshot_line_id), 0)
      `);
      this.db.exec(`
        DELETE FROM snapshot_items WHERE id NOT IN (
          SELECT MIN(id) FROM snapshot_items GROUP BY snapshot_id, item_code
        )
      `);
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_items_unique ON snapshot_items(snapshot_id, item_code)");
      const items = Number(this.db.prepare("SELECT COUNT(*) AS count FROM snapshot_items").get().count);
      if (items > 0) this.logger.info(`스냅샷 품번 ${items}건에 중복 방지 인덱스를 적용했습니다.`);
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshot_items_unique ON snapshot_items(snapshot_id, item_code)");
    // 세트 소속 컬럼이 갖춰진 뒤에 만들어야 합니다.
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_major_categories_set ON major_categories(category_set_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_item_mappings_set ON item_mappings(category_set_id)");
  }

  /** 기존 단일 분류 체계를 '설정 v1'로 옮기고, 세트 소속 컬럼을 붙입니다. */
  migrateCategorySets() {
    const existing = Number(this.db.prepare("SELECT COUNT(*) AS count FROM category_sets").get().count);
    let setId;
    if (existing === 0) {
      const timestamp = nowIso();
      setId = Number(this.db.prepare(`
        INSERT INTO category_sets (version_no, title, is_current, created_at, updated_at, created_by)
        VALUES (1, ?, 1, ?, ?, '')
      `).run("최초 설정", timestamp, timestamp).lastInsertRowid);
    } else {
      setId = Number(this.db.prepare("SELECT id FROM category_sets ORDER BY version_no LIMIT 1").get().id);
    }

    // 부모 테이블을 다시 만드는 동안에는 외래키 검사를 잠시 끕니다.
    // id 를 그대로 옮기므로 자식(middle_categories)의 참조는 유지됩니다.
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE major_categories_new (
          id INTEGER PRIMARY KEY,
          category_set_id INTEGER NOT NULL REFERENCES category_sets(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          sort_order INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1,
          UNIQUE(category_set_id, name)
        );
      `);
      this.db.prepare(`
        INSERT INTO major_categories_new (id, category_set_id, name, sort_order, is_active)
        SELECT id, ?, name, sort_order, is_active FROM major_categories
      `).run(setId);
      this.db.exec("DROP TABLE major_categories");
      this.db.exec("ALTER TABLE major_categories_new RENAME TO major_categories");

      this.db.exec(`
        CREATE TABLE item_mappings_new (
          id INTEGER PRIMARY KEY,
          category_set_id INTEGER NOT NULL REFERENCES category_sets(id) ON DELETE CASCADE,
          middle_category_id INTEGER NOT NULL REFERENCES middle_categories(id) ON DELETE CASCADE,
          item_code TEXT NOT NULL,
          item_name TEXT NOT NULL,
          UNIQUE(category_set_id, item_code)
        );
      `);
      this.db.prepare(`
        INSERT INTO item_mappings_new (id, category_set_id, middle_category_id, item_code, item_name)
        SELECT id, ?, middle_category_id, item_code, item_name FROM item_mappings
      `).run(setId);
      this.db.exec("DROP TABLE item_mappings");
      this.db.exec("ALTER TABLE item_mappings_new RENAME TO item_mappings");
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* 무시 */ }
      this.db.exec("PRAGMA foreign_keys = ON");
      throw error;
    }
    const broken = this.db.prepare("PRAGMA foreign_key_check").all();
    this.db.exec("PRAGMA foreign_keys = ON");
    if (broken.length) throw new Error(`분류 설정 마이그레이션 후 참조 오류가 남았습니다: ${JSON.stringify(broken).slice(0, 200)}`);

    const moved = Number(this.db.prepare("SELECT COUNT(*) AS count FROM major_categories").get().count);
    if (moved > 0) this.logger.info(`기존 분류 체계를 '설정 v1'로 옮겼습니다. 대분류 ${moved}건.`);
  }

  /** 설정 세트가 하나도 없으면 만들고, '사용 중'이 정확히 하나가 되도록 맞춥니다. */
  ensureCurrentCategorySet() {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM category_sets").get().count);
    if (count === 0) {
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO category_sets (version_no, title, is_current, created_at, updated_at, created_by)
        VALUES (1, ?, 1, ?, ?, '')
      `).run("최초 설정", timestamp, timestamp);
      return;
    }
    const current = Number(this.db.prepare("SELECT COUNT(*) AS count FROM category_sets WHERE is_current = 1").get().count);
    if (current === 1) return;
    this.db.exec("UPDATE category_sets SET is_current = 0");
    this.db.exec("UPDATE category_sets SET is_current = 1 WHERE id = (SELECT id FROM category_sets ORDER BY version_no DESC LIMIT 1)");
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* 이미 롤백된 경우는 무시합니다. */
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------- 설정

  readSetting(key, fallback = "") {
    const row = this.db.prepare("SELECT setting_value AS value FROM app_settings WHERE setting_key = ?").get(key);
    if (!row) return fallback;
    const value = ENCRYPTED_SETTING_KEYS.includes(key) ? this.secretVault.decrypt(row.value) : row.value;
    return value === "" ? fallback : value;
  }

  writeSettings(entries) {
    const upsert = this.db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `);
    const updatedAt = nowIso();
    for (const [key, rawValue] of Object.entries(entries)) {
      const value = ENCRYPTED_SETTING_KEYS.includes(key)
        ? (rawValue ? this.secretVault.encrypt(String(rawValue)) : "")
        : String(rawValue ?? "");
      upsert.run(key, value, updatedAt);
    }
  }

  initializeAmaranceSettings(settings) {
    const current = this.db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?").get(AMARANCE_SETTING_KEY.MODE);
    if (Number(current.count) > 0) return this.getAmaranceSettings();
    return this.saveAmaranceSettings(settings);
  }

  getAmaranceSettings() {
    return {
      mode: this.readSetting(AMARANCE_SETTING_KEY.MODE, AMARANCE_MODE.DEMO),
      baseUrl: this.readSetting(AMARANCE_SETTING_KEY.BASE_URL),
      companyCode: this.readSetting(AMARANCE_SETTING_KEY.COMPANY_CODE),
      callerName: this.readSetting(AMARANCE_SETTING_KEY.CALLER_NAME),
      accessToken: this.readSetting(AMARANCE_SETTING_KEY.ACCESS_TOKEN),
      hashKey: this.readSetting(AMARANCE_SETTING_KEY.HASH_KEY),
      groupSeq: this.readSetting(AMARANCE_SETTING_KEY.GROUP_SEQ),
    };
  }

  saveAmaranceSettings(settings) {
    this.transaction(() => {
      this.writeSettings({
        [AMARANCE_SETTING_KEY.MODE]: String(settings.mode || AMARANCE_MODE.DEMO).toUpperCase(),
        [AMARANCE_SETTING_KEY.BASE_URL]: String(settings.baseUrl || "").trim().replace(/\/$/, ""),
        [AMARANCE_SETTING_KEY.COMPANY_CODE]: String(settings.companyCode || "").trim(),
        [AMARANCE_SETTING_KEY.CALLER_NAME]: String(settings.callerName || "").trim(),
        [AMARANCE_SETTING_KEY.ACCESS_TOKEN]: String(settings.accessToken || ""),
        [AMARANCE_SETTING_KEY.HASH_KEY]: String(settings.hashKey || ""),
        [AMARANCE_SETTING_KEY.GROUP_SEQ]: String(settings.groupSeq || "").trim(),
      });
    });
    return this.getAmaranceSettings();
  }

  getSsoSettings() {
    const signatureMode = this.readSetting(SSO_SETTING_KEY.SIGNATURE_MODE, SSO_SIGNATURE_MODE.PARAMS_SORTED);
    return {
      enabled: parseBoolean(this.readSetting(SSO_SETTING_KEY.ENABLED, "0")),
      signatureMode: Object.values(SSO_SIGNATURE_MODE).includes(signatureMode) ? signatureMode : SSO_SIGNATURE_MODE.PARAMS_SORTED,
      userParam: this.readSetting(SSO_SETTING_KEY.USER_PARAM, "userId"),
      nameParam: this.readSetting(SSO_SETTING_KEY.NAME_PARAM, "userNm"),
      timestampParam: this.readSetting(SSO_SETTING_KEY.TIMESTAMP_PARAM, "timestamp"),
      signatureParam: this.readSetting(SSO_SETTING_KEY.SIGNATURE_PARAM, "sign"),
      allowedIps: this.readSetting(SSO_SETTING_KEY.ALLOWED_IPS).split(",").map((value) => value.trim()).filter(Boolean),
      autoCreateUser: parseBoolean(this.readSetting(SSO_SETTING_KEY.AUTO_CREATE_USER, "0")),
      defaultRole: Object.values(USER_ROLE).includes(this.readSetting(SSO_SETTING_KEY.DEFAULT_ROLE))
        ? this.readSetting(SSO_SETTING_KEY.DEFAULT_ROLE)
        : USER_ROLE.VIEWER,
      toleranceSeconds: boundedNumber(this.readSetting(SSO_SETTING_KEY.TOLERANCE_SECONDS), DEFAULT_SSO_TOLERANCE_SECONDS, 30, 3600),
    };
  }

  saveSsoSettings(settings) {
    const signatureMode = String(settings.signatureMode || SSO_SIGNATURE_MODE.PARAMS_SORTED).toUpperCase();
    if (!Object.values(SSO_SIGNATURE_MODE).includes(signatureMode)) throw badRequest("서명 검증 방식이 올바르지 않습니다.");
    const allowedIps = String(settings.allowedIps || "").split(",").map((value) => value.trim()).filter(Boolean);
    const enabled = Boolean(settings.enabled);
    if (enabled && signatureMode === SSO_SIGNATURE_MODE.NONE && allowedIps.length === 0) {
      throw badRequest("서명을 검증하지 않으려면 허용 IP를 한 개 이상 지정해야 합니다.");
    }
    const defaultRole = String(settings.defaultRole || USER_ROLE.VIEWER).toUpperCase();
    if (!Object.values(USER_ROLE).includes(defaultRole)) throw badRequest("기본 권한이 올바르지 않습니다.");

    this.transaction(() => {
      this.writeSettings({
        [SSO_SETTING_KEY.ENABLED]: booleanText(enabled),
        [SSO_SETTING_KEY.SIGNATURE_MODE]: signatureMode,
        [SSO_SETTING_KEY.USER_PARAM]: normalizeName(settings.userParam || "userId", "사용자 파라미터명", 50),
        [SSO_SETTING_KEY.NAME_PARAM]: String(settings.nameParam || "").trim().slice(0, 50),
        [SSO_SETTING_KEY.TIMESTAMP_PARAM]: String(settings.timestampParam || "").trim().slice(0, 50),
        [SSO_SETTING_KEY.SIGNATURE_PARAM]: String(settings.signatureParam || "sign").trim().slice(0, 50),
        [SSO_SETTING_KEY.ALLOWED_IPS]: allowedIps.join(","),
        [SSO_SETTING_KEY.AUTO_CREATE_USER]: booleanText(settings.autoCreateUser),
        [SSO_SETTING_KEY.DEFAULT_ROLE]: defaultRole,
        [SSO_SETTING_KEY.TOLERANCE_SECONDS]: String(boundedNumber(settings.toleranceSeconds, DEFAULT_SSO_TOLERANCE_SECONDS, 30, 3600)),
      });
    });
    return this.getSsoSettings();
  }

  getSecuritySettings() {
    const sameSite = this.readSetting(SECURITY_SETTING_KEY.COOKIE_SAMESITE, COOKIE_SAMESITE.LAX);
    return {
      frameAncestors: this.readSetting(SECURITY_SETTING_KEY.FRAME_ANCESTORS, ""),
      cookieSameSite: Object.values(COOKIE_SAMESITE).includes(sameSite) ? sameSite : COOKIE_SAMESITE.LAX,
      cookieSecure: parseBoolean(this.readSetting(SECURITY_SETTING_KEY.COOKIE_SECURE, "0")),
      trustProxy: parseBoolean(this.readSetting(SECURITY_SETTING_KEY.TRUST_PROXY, "0")),
      sessionIdleMinutes: boundedNumber(this.readSetting(SECURITY_SETTING_KEY.SESSION_IDLE_MINUTES), DEFAULT_SESSION_IDLE_MINUTES, 5, 1440),
      sessionAbsoluteHours: boundedNumber(this.readSetting(SECURITY_SETTING_KEY.SESSION_ABSOLUTE_HOURS), DEFAULT_SESSION_ABSOLUTE_HOURS, 1, 168),
      receiptMaxRangeDays: boundedNumber(this.readSetting(SECURITY_SETTING_KEY.RECEIPT_MAX_RANGE_DAYS), DEFAULT_RECEIPT_MAX_RANGE_DAYS, 7, 1830),
    };
  }

  saveSecuritySettings(settings) {
    const sameSite = String(settings.cookieSameSite || COOKIE_SAMESITE.LAX);
    if (!Object.values(COOKIE_SAMESITE).includes(sameSite)) throw badRequest("쿠키 SameSite 값이 올바르지 않습니다.");
    const frameAncestors = String(settings.frameAncestors || "")
      .split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
    for (const origin of frameAncestors) {
      if (!/^https?:\/\/[^\s/]+$/.test(origin)) {
        throw badRequest(`iframe 허용 주소 형식이 올바르지 않습니다: ${origin} (예: https://erp.example.com)`);
      }
    }
    // SameSite=None 쿠키는 Secure 없이는 브라우저가 버리므로 함께 강제합니다.
    const cookieSecure = sameSite === COOKIE_SAMESITE.NONE ? true : Boolean(settings.cookieSecure);

    this.transaction(() => {
      this.writeSettings({
        [SECURITY_SETTING_KEY.FRAME_ANCESTORS]: frameAncestors.join(" "),
        [SECURITY_SETTING_KEY.COOKIE_SAMESITE]: sameSite,
        [SECURITY_SETTING_KEY.COOKIE_SECURE]: booleanText(cookieSecure),
        [SECURITY_SETTING_KEY.TRUST_PROXY]: booleanText(settings.trustProxy),
        [SECURITY_SETTING_KEY.SESSION_IDLE_MINUTES]: String(boundedNumber(settings.sessionIdleMinutes, DEFAULT_SESSION_IDLE_MINUTES, 5, 1440)),
        [SECURITY_SETTING_KEY.SESSION_ABSOLUTE_HOURS]: String(boundedNumber(settings.sessionAbsoluteHours, DEFAULT_SESSION_ABSOLUTE_HOURS, 1, 168)),
        [SECURITY_SETTING_KEY.RECEIPT_MAX_RANGE_DAYS]: String(boundedNumber(settings.receiptMaxRangeDays, DEFAULT_RECEIPT_MAX_RANGE_DAYS, 7, 1830)),
      });
    });
    return this.getSecuritySettings();
  }

  // ---------------------------------------------------------------- 사용자

  mapUser(row) {
    if (!row) return null;
    return {
      id: row.id,
      loginId: row.login_id,
      name: row.name,
      role: row.role,
      passwordHash: row.password_hash,
      hasPassword: Boolean(row.password_hash),
      mustChangePassword: Boolean(row.must_change_password),
      isActive: Boolean(row.is_active),
      origin: row.origin,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastLoginAt: row.last_login_at,
    };
  }

  /** 화면으로 내보낼 때는 비밀번호 해시를 제거합니다. */
  publicUser(user) {
    if (!user) return null;
    const { passwordHash, ...rest } = user;
    return rest;
  }

  findUserByLoginId(loginId) {
    return this.mapUser(this.db.prepare("SELECT * FROM users WHERE login_id = ? COLLATE NOCASE").get(String(loginId ?? "").trim()));
  }

  getUser(id) {
    return this.mapUser(this.db.prepare("SELECT * FROM users WHERE id = ?").get(id));
  }

  listUsers() {
    return this.db.prepare("SELECT * FROM users ORDER BY CASE role WHEN 'ADMIN' THEN 0 WHEN 'EDITOR' THEN 1 ELSE 2 END, login_id")
      .all().map((row) => this.publicUser(this.mapUser(row)));
  }

  countActiveAdmins(excludeUserId = 0) {
    return Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE role = ? AND is_active = 1 AND id <> ?",
    ).get(USER_ROLE.ADMIN, excludeUserId).count);
  }

  createUser({ loginId, name, role, passwordHash = null, mustChangePassword = false, origin = "LOCAL" }) {
    const normalizedLoginId = normalizeName(loginId, "로그인 ID", 60);
    if (!/^[A-Za-z0-9._@-]+$/.test(normalizedLoginId)) {
      throw badRequest("로그인 ID는 영문, 숫자, 마침표, 밑줄, @, - 만 사용할 수 있습니다.");
    }
    const normalizedRole = String(role || USER_ROLE.VIEWER).toUpperCase();
    if (!Object.values(USER_ROLE).includes(normalizedRole)) throw badRequest("권한 값이 올바르지 않습니다.");
    const timestamp = nowIso();
    const result = this.db.prepare(`
      INSERT INTO users (login_id, name, role, password_hash, must_change_password, is_active, origin, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(normalizedLoginId, normalizeName(name, "이름", 60), normalizedRole, passwordHash, mustChangePassword ? 1 : 0, origin, timestamp, timestamp);
    return this.publicUser(this.getUser(Number(result.lastInsertRowid)));
  }

  updateUser(id, { name, role, isActive }) {
    const user = this.getUser(id);
    if (!user) throw notFound("사용자를 찾을 수 없습니다.");
    const normalizedRole = String(role || user.role).toUpperCase();
    if (!Object.values(USER_ROLE).includes(normalizedRole)) throw badRequest("권한 값이 올바르지 않습니다.");
    const nextActive = isActive === undefined ? user.isActive : Boolean(isActive);
    // 마지막 관리자를 잠그거나 권한을 낮추면 아무도 설정을 못 바꾸게 됩니다.
    const losesAdmin = user.role === USER_ROLE.ADMIN && (normalizedRole !== USER_ROLE.ADMIN || !nextActive);
    if (losesAdmin && this.countActiveAdmins(user.id) === 0) {
      throw conflict("마지막 관리자 계정의 권한은 변경할 수 없습니다. 다른 관리자를 먼저 지정해 주세요.");
    }
    this.db.prepare("UPDATE users SET name = ?, role = ?, is_active = ?, updated_at = ? WHERE id = ?")
      .run(normalizeName(name ?? user.name, "이름", 60), normalizedRole, nextActive ? 1 : 0, nowIso(), id);
    if (!nextActive) this.deleteSessionsForUser(id);
    return this.publicUser(this.getUser(id));
  }

  updateUserName(id, name) {
    this.db.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").run(String(name).slice(0, 60), nowIso(), id);
  }

  setUserPassword(id, passwordHash, { mustChangePassword = false } = {}) {
    const result = this.db.prepare("UPDATE users SET password_hash = ?, must_change_password = ?, updated_at = ? WHERE id = ?")
      .run(passwordHash, mustChangePassword ? 1 : 0, nowIso(), id);
    if (result.changes === 0) throw notFound("사용자를 찾을 수 없습니다.");
  }

  deleteUser(id) {
    const user = this.getUser(id);
    if (!user) throw notFound("사용자를 찾을 수 없습니다.");
    if (user.role === USER_ROLE.ADMIN && this.countActiveAdmins(user.id) === 0) {
      throw conflict("마지막 관리자 계정은 삭제할 수 없습니다.");
    }
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
    return user;
  }

  markUserLoggedIn(id) {
    this.db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").run(nowIso(), id);
  }

  /**
   * 사용자가 하나도 없으면 최초 관리자 계정을 만들고 임시 비밀번호를 돌려줍니다.
   * 임시 비밀번호는 로그에만 남고 DB에는 해시만 저장됩니다.
   */
  ensureBootstrapAdmin() {
    const count = Number(this.db.prepare("SELECT COUNT(*) AS count FROM users").get().count);
    if (count > 0) return null;
    const password = generateReadablePassword(14);
    this.createUser({
      loginId: BOOTSTRAP_ADMIN_LOGIN_ID,
      name: "최초 관리자",
      role: USER_ROLE.ADMIN,
      passwordHash: hashPassword(password),
      mustChangePassword: true,
    });
    return { loginId: BOOTSTRAP_ADMIN_LOGIN_ID, password };
  }

  // ---------------------------------------------------------------- 세션

  createSession(session) {
    this.db.prepare(`
      INSERT INTO sessions (id, user_id, csrf_token, created_at, last_seen_at, absolute_expires_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(session.id, session.userId, session.csrfToken, session.createdAt, session.lastSeenAt, session.absoluteExpiresAt, session.ip, session.userAgent);
    return session;
  }

  findSession(id) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(String(id));
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      absoluteExpiresAt: row.absolute_expires_at,
      ip: row.ip,
      userAgent: row.user_agent,
    };
  }

  touchSession(id, timestamp) {
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(timestamp, id);
  }

  deleteSession(id) {
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(String(id));
  }

  deleteSessionsForUser(userId) {
    this.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }

  /** 만료된 세션과 SSO 논스를 정리합니다. 주기적으로 호출합니다. */
  purgeExpired() {
    const timestamp = nowIso();
    const sessions = this.db.prepare("DELETE FROM sessions WHERE absolute_expires_at < ?").run(timestamp);
    const nonces = this.db.prepare("DELETE FROM sso_nonces WHERE expires_at < ?").run(timestamp);
    return { sessions: sessions.changes, nonces: nonces.changes };
  }

  /** 처음 보는 서명이면 기록하고 true, 이미 쓰인 서명이면 false 를 돌려줍니다. */
  consumeSsoSignature(signature, toleranceSeconds) {
    this.db.prepare("DELETE FROM sso_nonces WHERE expires_at < ?").run(nowIso());
    const expiresAt = new Date(Date.now() + (toleranceSeconds + 60) * 1000).toISOString();
    try {
      this.db.prepare("INSERT INTO sso_nonces (signature, expires_at) VALUES (?, ?)").run(String(signature), expiresAt);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------- 감사 로그

  recordAudit({ actor, action, targetType = "", targetId = "", detail = "", ip = "" }) {
    this.db.prepare(`
      INSERT INTO audit_logs (created_at, user_id, login_id, user_name, action, target_type, target_id, detail, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      nowIso(),
      actor?.id ?? null,
      String(actor?.loginId ?? ""),
      String(actor?.name ?? ""),
      String(action),
      String(targetType),
      String(targetId),
      String(detail).slice(0, 500),
      String(ip),
    );
  }

  listAuditLogs({ limit = 100, offset = 0, action = "", loginId = "" } = {}) {
    const conditions = [];
    const parameters = [];
    if (action) {
      conditions.push("action = ?");
      parameters.push(action);
    }
    if (loginId) {
      conditions.push("login_id LIKE ?");
      parameters.push(`%${loginId}%`);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${where}`).get(...parameters).count);
    const rows = this.db.prepare(`
      SELECT id, created_at AS createdAt, login_id AS loginId, user_name AS userName,
             action, target_type AS targetType, target_id AS targetId, detail, ip
      FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...parameters, boundedNumber(limit, 100, 1, 500), Math.max(0, Number(offset) || 0));
    return { total, rows };
  }

  // ---------------------------------------------------------------- 분류

  // ---------------------------------------------------------------- 분류 설정 버전(세트)

  getCurrentCategorySetId() {
    const row = this.db.prepare("SELECT id FROM category_sets WHERE is_current = 1 ORDER BY version_no DESC LIMIT 1").get();
    if (row) return row.id;
    this.ensureCurrentCategorySet();
    return this.db.prepare("SELECT id FROM category_sets WHERE is_current = 1 LIMIT 1").get().id;
  }

  assertCategorySet(id) {
    const row = this.db.prepare("SELECT id, version_no AS versionNo, title, is_current AS isCurrent FROM category_sets WHERE id = ?")
      .get(positiveInteger(id, "설정 버전 ID"));
    if (!row) throw notFound("설정 버전을 찾을 수 없습니다.");
    return { ...row, isCurrent: Boolean(row.isCurrent) };
  }

  categorySetIdOfMiddle(middleCategoryId) {
    const row = this.db.prepare(`
      SELECT jc.category_set_id AS categorySetId
      FROM middle_categories mc JOIN major_categories jc ON jc.id = mc.major_category_id
      WHERE mc.id = ?
    `).get(middleCategoryId);
    if (!row) throw notFound("중분류를 찾을 수 없습니다.");
    return row.categorySetId;
  }

  categorySetIdOfMajor(majorCategoryId) {
    const row = this.db.prepare("SELECT category_set_id AS categorySetId FROM major_categories WHERE id = ?").get(majorCategoryId);
    if (!row) throw notFound("대분류를 찾을 수 없습니다.");
    return row.categorySetId;
  }

  touchCategorySet(id) {
    this.db.prepare("UPDATE category_sets SET updated_at = ? WHERE id = ?").run(nowIso(), id);
  }

  listCategorySets() {
    return this.db.prepare(`
      SELECT cs.id, cs.version_no AS versionNo, cs.title, cs.is_current AS isCurrent,
             cs.created_at AS createdAt, cs.updated_at AS updatedAt, cs.created_by AS createdBy,
             (SELECT COUNT(*) FROM major_categories jc WHERE jc.category_set_id = cs.id) AS majorCount,
             (SELECT COUNT(*) FROM middle_categories mc
                JOIN major_categories jc2 ON jc2.id = mc.major_category_id
               WHERE jc2.category_set_id = cs.id) AS middleCount,
             (SELECT COUNT(*) FROM item_mappings im WHERE im.category_set_id = cs.id) AS itemCount,
             (SELECT COUNT(*) FROM snapshots s WHERE s.category_set_id = cs.id) AS snapshotCount
      FROM category_sets cs ORDER BY cs.version_no DESC
    `).all().map((row) => ({ ...row, isCurrent: Boolean(row.isCurrent) }));
  }

  /** 새 설정 버전을 만듭니다. cloneFromId 를 주면 그 버전의 분류·품번을 그대로 복사합니다. */
  createCategorySet({ title, cloneFromId = null, createdBy = "" } = {}) {
    return this.transaction(() => {
      const versionNo = Number(this.db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS next FROM category_sets").get().next);
      const timestamp = nowIso();
      const setId = Number(this.db.prepare(`
        INSERT INTO category_sets (version_no, title, is_current, created_at, updated_at, created_by)
        VALUES (?, ?, 0, ?, ?, ?)
      `).run(versionNo, normalizeName(title || `설정 ${versionNo}`, "설정 버전 이름", 60), timestamp, timestamp, String(createdBy)).lastInsertRowid);

      if (cloneFromId) {
        const source = this.assertCategorySet(cloneFromId);
        const insertMajor = this.db.prepare("INSERT INTO major_categories (category_set_id, name, sort_order, is_active) VALUES (?, ?, ?, ?)");
        const insertMiddle = this.db.prepare("INSERT INTO middle_categories (major_category_id, name, sort_order, is_active) VALUES (?, ?, ?, ?)");
        const insertItem = this.db.prepare("INSERT INTO item_mappings (category_set_id, middle_category_id, item_code, item_name) VALUES (?, ?, ?, ?)");
        const majors = this.db.prepare("SELECT * FROM major_categories WHERE category_set_id = ? ORDER BY sort_order, id").all(source.id);
        for (const major of majors) {
          const majorId = Number(insertMajor.run(setId, major.name, major.sort_order, major.is_active).lastInsertRowid);
          const middles = this.db.prepare("SELECT * FROM middle_categories WHERE major_category_id = ? ORDER BY sort_order, id").all(major.id);
          for (const middle of middles) {
            const middleId = Number(insertMiddle.run(majorId, middle.name, middle.sort_order, middle.is_active).lastInsertRowid);
            const items = this.db.prepare("SELECT item_code, item_name FROM item_mappings WHERE middle_category_id = ? ORDER BY item_code").all(middle.id);
            for (const item of items) insertItem.run(setId, middleId, item.item_code, item.item_name);
          }
        }
      }
      return this.assertCategorySet(setId);
    });
  }

  renameCategorySet(id, title) {
    const normalized = normalizeName(title, "설정 버전 이름", 60);
    const result = this.db.prepare("UPDATE category_sets SET title = ?, updated_at = ? WHERE id = ?").run(normalized, nowIso(), id);
    if (result.changes === 0) throw notFound("설정 버전을 찾을 수 없습니다.");
    return this.assertCategorySet(id);
  }

  setCurrentCategorySet(id) {
    const target = this.assertCategorySet(id);
    this.transaction(() => {
      this.db.exec("UPDATE category_sets SET is_current = 0");
      this.db.prepare("UPDATE category_sets SET is_current = 1, updated_at = ? WHERE id = ?").run(nowIso(), target.id);
    });
    return this.assertCategorySet(target.id);
  }

  deleteCategorySet(id) {
    const target = this.assertCategorySet(id);
    if (target.isCurrent) throw conflict("사용 중인 설정 버전은 삭제할 수 없습니다. 다른 버전을 먼저 사용 중으로 지정해 주세요.");
    const used = Number(this.db.prepare("SELECT COUNT(*) AS count FROM snapshots WHERE category_set_id = ?").get(target.id).count);
    if (used > 0) {
      throw conflict(`이 설정 버전으로 만든 집행서가 ${used.toLocaleString("ko-KR")}건 있어 삭제할 수 없습니다.`);
    }
    if (Number(this.db.prepare("SELECT COUNT(*) AS count FROM category_sets").get().count) <= 1) {
      throw conflict("설정 버전은 최소 한 개는 있어야 합니다.");
    }
    this.db.prepare("DELETE FROM category_sets WHERE id = ?").run(target.id);
    return target;
  }

  seedDemoData() {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM major_categories").get().count;
    if (count > 0) return;

    const demoCategories = [
      ["자재비", ["구매품", "배관자재", "전기자재"]],
      ["제작비", ["가공비", "검사/조립"]],
      ["현장비", ["설치비", "시운전비", "포장/운반비"]],
      ["관리비", ["PM 관리비"]],
    ];
    const demoItems = [
      ["구매품", "MAT-1001", "제어반 본체"],
      ["구매품", "MAT-1002", "인버터"],
      ["배관자재", "PIPE-2001", "스테인리스 배관"],
      ["전기자재", "ELEC-3001", "전력 케이블"],
      ["가공비", "PROC-4001", "프레임 가공"],
      ["검사/조립", "ASSY-5001", "장비 조립"],
      ["설치비", "SITE-6001", "현장 설치"],
      ["시운전비", "TEST-7001", "시운전"],
      ["포장/운반비", "SHIP-8001", "포장 및 운송"],
      ["PM 관리비", "PM-9001", "프로젝트 관리"],
    ];

    const setId = this.getCurrentCategorySetId();
    this.transaction(() => {
      const insertMajor = this.db.prepare("INSERT INTO major_categories (category_set_id, name, sort_order) VALUES (?, ?, ?)");
      const insertMiddle = this.db.prepare("INSERT INTO middle_categories (major_category_id, name, sort_order) VALUES (?, ?, ?)");
      const middleIds = new Map();
      demoCategories.forEach(([majorName, middleNames], majorIndex) => {
        const majorId = Number(insertMajor.run(setId, majorName, majorIndex + 1).lastInsertRowid);
        middleNames.forEach((middleName, middleIndex) => {
          middleIds.set(middleName, Number(insertMiddle.run(majorId, middleName, middleIndex + 1).lastInsertRowid));
        });
      });
      const insertItem = this.db.prepare("INSERT INTO item_mappings (category_set_id, middle_category_id, item_code, item_name) VALUES (?, ?, ?, ?)");
      for (const [middleName, itemCode, itemName] of demoItems) {
        insertItem.run(setId, middleIds.get(middleName), itemCode, itemName);
      }
    });
  }

  listCategories(categorySetId = null) {
    const setId = categorySetId ? this.assertCategorySet(categorySetId).id : this.getCurrentCategorySetId();
    const majors = this.db.prepare("SELECT id, name, sort_order AS sortOrder FROM major_categories WHERE category_set_id = ? AND is_active = 1 ORDER BY sort_order, id").all(setId);
    const middles = this.db.prepare(`
      SELECT mc.id, mc.major_category_id AS majorCategoryId, mc.name, mc.sort_order AS sortOrder
      FROM middle_categories mc JOIN major_categories jc ON jc.id = mc.major_category_id
      WHERE jc.category_set_id = ? AND mc.is_active = 1 ORDER BY mc.sort_order, mc.id
    `).all(setId);
    const items = this.db.prepare("SELECT id, middle_category_id AS middleCategoryId, item_code AS itemCode, item_name AS itemName FROM item_mappings WHERE category_set_id = ? ORDER BY item_code").all(setId);

    const middlesByMajor = new Map();
    for (const middle of middles) {
      if (!middlesByMajor.has(middle.majorCategoryId)) middlesByMajor.set(middle.majorCategoryId, []);
      middlesByMajor.get(middle.majorCategoryId).push(middle);
    }
    const itemsByMiddle = new Map();
    for (const item of items) {
      if (!itemsByMiddle.has(item.middleCategoryId)) itemsByMiddle.set(item.middleCategoryId, []);
      itemsByMiddle.get(item.middleCategoryId).push(item);
    }
    return majors.map((major) => ({
      ...major,
      middleCategories: (middlesByMajor.get(major.id) || []).map((middle) => ({
        ...middle,
        items: itemsByMiddle.get(middle.id) || [],
      })),
    }));
  }

  /** 이미 다른 중분류에 연결된 품번 목록. 검색 결과에 '연결됨' 표시를 하는 데 씁니다. */
  listMappedItemCodes(categorySetId = null) {
    const setId = categorySetId ? this.assertCategorySet(categorySetId).id : this.getCurrentCategorySetId();
    return this.db.prepare(`
      SELECT im.item_code AS itemCode, mc.name AS middleName, jc.name AS majorName
      FROM item_mappings im
      JOIN middle_categories mc ON mc.id = im.middle_category_id
      JOIN major_categories jc ON jc.id = mc.major_category_id
      WHERE im.category_set_id = ?
    `).all(setId);
  }

  createMajorCategory(data) {
    const name = normalizeName(data.name, "대분류명", 60);
    const setId = data.categorySetId ? this.assertCategorySet(data.categorySetId).id : this.getCurrentCategorySetId();
    const nextOrder = Number(this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM major_categories WHERE category_set_id = ?").get(setId).next);
    const result = this.db.prepare("INSERT INTO major_categories (category_set_id, name, sort_order) VALUES (?, ?, ?)").run(setId, name, nextOrder);
    this.touchCategorySet(setId);
    return { id: Number(result.lastInsertRowid), categorySetId: setId, name, sortOrder: nextOrder };
  }

  updateMajorCategory(id, data) {
    const name = normalizeName(data.name, "대분류명", 60);
    const setId = this.categorySetIdOfMajor(id);
    const result = this.db.prepare("UPDATE major_categories SET name = ? WHERE id = ?").run(name, id);
    if (result.changes === 0) throw notFound("대분류를 찾을 수 없습니다.");
    this.touchCategorySet(setId);
  }

  deleteMajorCategory(id) {
    const existing = this.db.prepare("SELECT name, category_set_id AS categorySetId FROM major_categories WHERE id = ?").get(id);
    if (!existing) throw notFound("대분류를 찾을 수 없습니다.");
    this.db.prepare("DELETE FROM major_categories WHERE id = ?").run(id);
    this.touchCategorySet(existing.categorySetId);
    return existing.name;
  }

  createMiddleCategory(data) {
    const name = normalizeName(data.name, "중분류명", 60);
    const majorCategoryId = positiveInteger(data.majorCategoryId, "대분류 ID");
    const nextOrder = Number(this.db.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM middle_categories WHERE major_category_id = ?").get(majorCategoryId).next);
    const result = this.db.prepare("INSERT INTO middle_categories (major_category_id, name, sort_order) VALUES (?, ?, ?)").run(majorCategoryId, name, nextOrder);
    this.touchCategorySet(this.categorySetIdOfMajor(majorCategoryId));
    return { id: Number(result.lastInsertRowid), majorCategoryId, name, sortOrder: nextOrder };
  }

  updateMiddleCategory(id, data) {
    const name = normalizeName(data.name, "중분류명", 60);
    const setId = this.categorySetIdOfMiddle(id);
    const result = this.db.prepare("UPDATE middle_categories SET name = ? WHERE id = ?").run(name, id);
    if (result.changes === 0) throw notFound("중분류를 찾을 수 없습니다.");
    this.touchCategorySet(setId);
  }

  deleteMiddleCategory(id) {
    const existing = this.db.prepare("SELECT name FROM middle_categories WHERE id = ?").get(id);
    if (!existing) throw notFound("중분류를 찾을 수 없습니다.");
    const setId = this.categorySetIdOfMiddle(id);
    this.db.prepare("DELETE FROM middle_categories WHERE id = ?").run(id);
    this.touchCategorySet(setId);
    return existing.name;
  }

  /**
   * 분류 순서를 한 칸 위/아래로 옮깁니다.
   * @param {"major"|"middle"} kind
   */
  moveCategory(kind, id, direction) {
    const step = direction === "up" ? -1 : 1;
    const table = kind === "major" ? "major_categories" : "middle_categories";
    return this.transaction(() => {
      const current = this.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
      if (!current) throw notFound(kind === "major" ? "대분류를 찾을 수 없습니다." : "중분류를 찾을 수 없습니다.");
      const siblings = kind === "major"
        ? this.db.prepare("SELECT id, sort_order FROM major_categories WHERE is_active = 1 AND category_set_id = ? ORDER BY sort_order, id").all(current.category_set_id)
        : this.db.prepare("SELECT id, sort_order FROM middle_categories WHERE is_active = 1 AND major_category_id = ? ORDER BY sort_order, id").all(current.major_category_id);

      const index = siblings.findIndex((row) => row.id === current.id);
      const targetIndex = index + step;
      if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return false;
      [siblings[index], siblings[targetIndex]] = [siblings[targetIndex], siblings[index]];
      const update = this.db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
      siblings.forEach((row, position) => update.run(position + 1, row.id));
      return true;
    });
  }

  createItemMapping(data) {
    const middleCategoryId = positiveInteger(data.middleCategoryId, "중분류 ID");
    const itemCode = normalizeName(data.itemCode, "품번", 60);
    const itemName = normalizeName(data.itemName, "품명", 120);
    const setId = this.categorySetIdOfMiddle(middleCategoryId);
    const result = this.db.prepare("INSERT INTO item_mappings (category_set_id, middle_category_id, item_code, item_name) VALUES (?, ?, ?, ?)")
      .run(setId, middleCategoryId, itemCode, itemName);
    this.touchCategorySet(setId);
    return { id: Number(result.lastInsertRowid), middleCategoryId, itemCode, itemName };
  }

  deleteItemMapping(id) {
    const existing = this.db.prepare("SELECT item_code AS itemCode, category_set_id AS categorySetId FROM item_mappings WHERE id = ?").get(id);
    if (!existing) throw notFound("품번 연결을 찾을 수 없습니다.");
    this.db.prepare("DELETE FROM item_mappings WHERE id = ?").run(id);
    this.touchCategorySet(existing.categorySetId);
    return existing.itemCode;
  }

  // ---------------------------------------------------------------- 프로젝트

  /**
   * 아마란스10 조회 결과를 프로젝트 목록에 반영합니다.
   *
   * reconcile 을 켜면 응답에 없는 프로젝트까지 정리합니다.
   *  - 집행서가 하나도 없는 프로젝트: 삭제 (연동 전 시험 데이터 정리용)
   *  - 집행서가 있는 프로젝트: 절대 삭제하지 않고 '보관' 표시만
   *    (projects 삭제는 snapshots 로 연쇄되어 확정본까지 지워집니다)
   */
  upsertProjects(projects, { reconcile = false } = {}) {
    const statement = this.db.prepare(`
      INSERT INTO projects (code, name, contract_amount, status, synced_at, is_archived)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        contract_amount = excluded.contract_amount,
        status = excluded.status,
        synced_at = excluded.synced_at,
        is_archived = 0
    `);
    const syncedAt = nowIso();
    const summary = { received: projects.length, created: 0, updated: 0, restored: 0, archived: 0, removed: 0 };

    this.transaction(() => {
      const before = new Map(
        this.db.prepare("SELECT code, is_archived AS isArchived FROM projects").all()
          .map((row) => [row.code, Boolean(row.isArchived)]),
      );
      const receivedCodes = new Set();

      for (const project of projects) {
        const code = normalizeName(project.code, "프로젝트코드", 60);
        receivedCodes.add(code);
        if (!before.has(code)) summary.created += 1;
        else {
          summary.updated += 1;
          if (before.get(code)) summary.restored += 1;
        }
        statement.run(
          code,
          normalizeName(project.name, "프로젝트명", 200),
          toWon(project.contractAmount),
          Object.values(PROJECT_STATUS).includes(project.status) ? project.status : PROJECT_STATUS.ACTIVE,
          syncedAt,
        );
      }

      if (!reconcile) return;

      const stale = this.db.prepare(`
        SELECT p.id, p.code, p.is_archived AS isArchived,
               (SELECT COUNT(*) FROM snapshots s WHERE s.project_id = p.id) AS snapshotCount
        FROM projects p
      `).all().filter((row) => !receivedCodes.has(row.code));

      const archive = this.db.prepare("UPDATE projects SET is_archived = 1 WHERE id = ?");
      const remove = this.db.prepare("DELETE FROM projects WHERE id = ?");
      for (const row of stale) {
        if (Number(row.snapshotCount) === 0) {
          remove.run(row.id);
          summary.removed += 1;
        } else if (!row.isArchived) {
          archive.run(row.id);
          summary.archived += 1;
        }
      }
    });

    return { projects: this.listProjects(), summary };
  }

  listProjects() {
    return this.db.prepare(`
      SELECT id, code, name, contract_amount AS contractAmount, status, synced_at AS syncedAt,
             is_archived AS isArchived
      FROM projects
      ORDER BY is_archived,
               CASE status WHEN '${PROJECT_STATUS.ACTIVE}' THEN 0 ELSE 1 END,
               code DESC
    `).all().map((row) => ({ ...row, isArchived: Boolean(row.isArchived) }));
  }

  // ---------------------------------------------------------------- 스냅샷

  listSnapshots(projectId) {
    return this.db.prepare(`
      SELECT id, project_id AS projectId, version_no AS versionNo, title, status,
             contract_amount AS contractAmount, revision, created_at AS createdAt, updated_at AS updatedAt,
             created_by AS createdBy, confirmed_by AS confirmedBy, confirmed_at AS confirmedAt,
             category_set_id AS categorySetId, category_set_label AS categorySetLabel
      FROM snapshots WHERE project_id = ? ORDER BY version_no DESC
    `).all(positiveInteger(projectId, "프로젝트 ID"));
  }

  createSnapshot(projectId, options = {}) {
    const project = this.db.prepare("SELECT id, contract_amount AS contractAmount FROM projects WHERE id = ?").get(projectId);
    if (!project) throw notFound("프로젝트를 찾을 수 없습니다.");
    const createdAt = nowIso();

    return this.transaction(() => {
      const versionNo = Number(this.db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS versionNo FROM snapshots WHERE project_id = ?").get(projectId).versionNo);
      const title = String(options.title ?? "").trim() || `버전 ${versionNo}`;

      // 복제본은 원본이 쓰던 설정 버전을, 새로 만들면 지정한(없으면 사용 중) 설정 버전을 따릅니다.
      let categorySet;
      if (options.cloneSnapshotId) {
        const source = this.db.prepare("SELECT category_set_id AS categorySetId, category_set_label AS label FROM snapshots WHERE id = ?")
          .get(Number(options.cloneSnapshotId));
        categorySet = { id: source?.categorySetId ?? null, label: source?.label ?? "" };
      } else {
        const chosen = this.assertCategorySet(options.categorySetId || this.getCurrentCategorySetId());
        categorySet = { id: chosen.id, label: `v${chosen.versionNo} · ${chosen.title}` };
      }

      const snapshotResult = this.db.prepare(`
        INSERT INTO snapshots (project_id, version_no, title, status, contract_amount, created_at, updated_at, created_by,
                               category_set_id, category_set_label)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(projectId, versionNo, title, SNAPSHOT_STATUS.DRAFT, toWon(project.contractAmount), createdAt, createdAt,
             String(options.createdBy ?? ""), categorySet.id, String(categorySet.label ?? ""));
      const snapshotId = Number(snapshotResult.lastInsertRowid);

      if (options.cloneSnapshotId) this.cloneSnapshotLines(snapshotId, Number(options.cloneSnapshotId));
      else this.captureCurrentCategories(snapshotId, categorySet.id);
      return this.getSnapshot(snapshotId);
    });
  }

  captureCurrentCategories(snapshotId, categorySetId = null) {
    const categories = this.listCategories(categorySetId);
    const insertLine = this.db.prepare(`
      INSERT INTO snapshot_lines (snapshot_id, major_name, middle_name, major_sort, middle_sort)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertItem = this.db.prepare("INSERT INTO snapshot_items (snapshot_line_id, snapshot_id, item_code, item_name) VALUES (?, ?, ?, ?)");
    const seenItemCodes = new Set();
    for (const major of categories) {
      for (const middle of major.middleCategories) {
        const lineId = Number(insertLine.run(snapshotId, major.name, middle.name, major.sortOrder, middle.sortOrder).lastInsertRowid);
        for (const item of middle.items) {
          if (seenItemCodes.has(item.itemCode)) continue;
          seenItemCodes.add(item.itemCode);
          insertItem.run(lineId, snapshotId, item.itemCode, item.itemName);
        }
      }
    }
  }

  cloneSnapshotLines(snapshotId, sourceSnapshotId) {
    const source = this.db.prepare(`
      SELECT source.id
      FROM snapshots source
      JOIN snapshots target ON target.id = ? AND target.project_id = source.project_id
      WHERE source.id = ?
    `).get(snapshotId, sourceSnapshotId);
    if (!source) throw notFound("복제할 버전을 찾을 수 없습니다.");
    const sourceLines = this.db.prepare("SELECT * FROM snapshot_lines WHERE snapshot_id = ? ORDER BY major_sort, middle_sort, id").all(sourceSnapshotId);
    const insertLine = this.db.prepare(`
      INSERT INTO snapshot_lines (snapshot_id, major_name, middle_name, major_sort, middle_sort, execution_budget, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const sourceItems = this.db.prepare("SELECT item_code, item_name FROM snapshot_items WHERE snapshot_line_id = ? ORDER BY id");
    const insertItem = this.db.prepare("INSERT INTO snapshot_items (snapshot_line_id, snapshot_id, item_code, item_name) VALUES (?, ?, ?, ?)");
    const seenItemCodes = new Set();
    for (const line of sourceLines) {
      const lineId = Number(insertLine.run(snapshotId, line.major_name, line.middle_name, line.major_sort, line.middle_sort, line.execution_budget, line.remark).lastInsertRowid);
      for (const item of sourceItems.all(line.id)) {
        if (seenItemCodes.has(item.item_code)) continue;
        seenItemCodes.add(item.item_code);
        insertItem.run(lineId, snapshotId, item.item_code, item.item_name);
      }
    }
  }

  getSnapshot(snapshotId) {
    const id = positiveInteger(snapshotId, "버전 ID");
    const snapshot = this.db.prepare(`
      SELECT s.id, s.project_id AS projectId, s.version_no AS versionNo, s.title, s.status,
             s.contract_amount AS contractAmount, s.revision, s.created_at AS createdAt, s.updated_at AS updatedAt,
             s.created_by AS createdBy, s.confirmed_by AS confirmedBy, s.confirmed_at AS confirmedAt,
             s.category_set_id AS categorySetId, s.category_set_label AS categorySetLabel,
             p.code AS projectCode, p.name AS projectName,
             p.contract_amount AS projectContractAmount
      FROM snapshots s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
    `).get(id);
    if (!snapshot) throw notFound("집행서 버전을 찾을 수 없습니다.");

    const lines = this.db.prepare(`
      SELECT id, major_name AS majorName, middle_name AS middleName,
             execution_budget AS executionBudget, remark
      FROM snapshot_lines WHERE snapshot_id = ? ORDER BY major_sort, middle_sort, id
    `).all(id);
    const items = this.db.prepare(`
      SELECT snapshot_line_id AS snapshotLineId, item_code AS itemCode, item_name AS itemName
      FROM snapshot_items WHERE snapshot_id = ? ORDER BY item_code
    `).all(id);
    const purchases = this.db.prepare(`
      SELECT si.snapshot_line_id AS snapshotLineId, COALESCE(SUM(r.amount), 0) AS purchaseAmount
      FROM snapshot_items si
      LEFT JOIN receipts r ON r.snapshot_id = si.snapshot_id AND r.item_code = si.item_code
      WHERE si.snapshot_id = ? GROUP BY si.snapshot_line_id
    `).all(id);

    const itemsByLine = new Map();
    for (const item of items) {
      if (!itemsByLine.has(item.snapshotLineId)) itemsByLine.set(item.snapshotLineId, []);
      itemsByLine.get(item.snapshotLineId).push({ itemCode: item.itemCode, itemName: item.itemName });
    }
    const purchaseByLine = new Map(purchases.map((row) => [row.snapshotLineId, Number(row.purchaseAmount)]));
    const enrichedLines = lines.map((line) => ({
      ...line,
      items: itemsByLine.get(line.id) || [],
      ...calculateBudget(line.executionBudget, purchaseByLine.get(line.id) || 0),
    }));

    const purchaseAmount = enrichedLines.reduce((sum, line) => sum + line.purchaseAmount, 0);
    const executionBudget = enrichedLines.reduce((sum, line) => sum + line.executionBudget, 0);
    const receipts = this.listReceipts(id);
    // 스냅샷 품번에 없는 입고는 집계에서 빠지므로, 화면에서 안내할 수 있게 건수를 함께 넘깁니다.
    const { projectContractAmount, ...rest } = snapshot;
    return {
      ...rest,
      contractAmountChanged: toWon(projectContractAmount) !== toWon(snapshot.contractAmount),
      projectContractAmount: toWon(projectContractAmount),
      lines: enrichedLines,
      totals: {
        ...calculateSummary(snapshot.contractAmount, purchaseAmount),
        executionBudget,
        budgetBalance: executionBudget - purchaseAmount,
      },
      receipts,
    };
  }

  renameSnapshot(snapshotId, title) {
    const normalized = normalizeName(title, "버전 이름", 60);
    const result = this.db.prepare("UPDATE snapshots SET title = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(normalized, nowIso(), snapshotId);
    if (result.changes === 0) throw notFound("집행서 버전을 찾을 수 없습니다.");
    return this.getSnapshot(snapshotId);
  }

  deleteSnapshot(snapshotId) {
    const snapshot = this.db.prepare("SELECT id, version_no AS versionNo, title, status FROM snapshots WHERE id = ?").get(snapshotId);
    if (!snapshot) throw notFound("집행서 버전을 찾을 수 없습니다.");
    if (snapshot.status === SNAPSHOT_STATUS.CONFIRMED) {
      throw conflict("확정된 버전은 삭제할 수 없습니다. 기록 보존을 위해 남겨 둡니다.");
    }
    this.db.prepare("DELETE FROM snapshots WHERE id = ?").run(snapshotId);
    return snapshot;
  }

  /** 작성중 버전의 계약금액을 프로젝트의 현재 금액으로 다시 맞춥니다. */
  refreshSnapshotContractAmount(snapshotId) {
    return this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      const project = this.db.prepare(`
        SELECT p.contract_amount AS contractAmount FROM snapshots s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
      `).get(snapshotId);
      this.db.prepare("UPDATE snapshots SET contract_amount = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
        .run(toWon(project.contractAmount), nowIso(), snapshotId);
      return this.getSnapshot(snapshotId);
    });
  }

  /**
   * 여러 중분류의 실행예산과 비고를 한 번에 저장합니다.
   * expectedRevision 을 주면 그 사이 다른 사용자가 저장한 경우 409 로 막습니다.
   */
  updateSnapshotLines(snapshotId, lines, { expectedRevision = null } = {}) {
    if (!Array.isArray(lines)) throw badRequest("저장할 집행서 항목이 올바르지 않습니다.");
    if (lines.length > 1_000) throw badRequest("한 번에 저장할 수 있는 항목 수를 초과했습니다.");
    const update = this.db.prepare("UPDATE snapshot_lines SET execution_budget = ?, remark = ? WHERE id = ? AND snapshot_id = ?");
    const lineIds = new Set();

    this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      this.assertNotStale(snapshotId, expectedRevision);
      for (const line of lines) {
        const lineId = Number(line.id);
        if (!Number.isInteger(lineId) || lineId <= 0 || lineIds.has(lineId)) {
          throw badRequest("저장할 집행서 항목이 올바르지 않습니다.");
        }
        lineIds.add(lineId);
        const budget = toWon(line.executionBudget);
        if (budget < 0) throw badRequest("실행예산은 0원 이상이어야 합니다.");
        if (budget > 9_999_999_999_999) throw badRequest("실행예산 금액이 너무 큽니다.");
        const result = update.run(budget, String(line.remark ?? "").trim().slice(0, 200), lineId, snapshotId);
        if (result.changes === 0) throw notFound("집행서 항목을 찾을 수 없습니다.");
      }
      if (lines.length > 0) {
        this.touchSnapshot(snapshotId);
      }
    });
    return this.getSnapshot(snapshotId);
  }

  updateSnapshotLine(snapshotId, lineId, data) {
    return this.updateSnapshotLines(snapshotId, [{ id: lineId, ...data }], {
      expectedRevision: data.expectedRevision ?? null,
    });
  }

  setSnapshotStatus(snapshotId, status, { actorName = "" } = {}) {
    if (!Object.values(SNAPSHOT_STATUS).includes(status)) throw badRequest("올바르지 않은 버전 상태입니다.");
    const current = this.db.prepare("SELECT status FROM snapshots WHERE id = ?").get(snapshotId);
    if (!current) throw notFound("집행서 버전을 찾을 수 없습니다.");
    if (current.status === SNAPSHOT_STATUS.CONFIRMED && status !== SNAPSHOT_STATUS.CONFIRMED) {
      throw conflict("확정된 버전은 되돌릴 수 없습니다. 새 버전을 만들어 주세요.");
    }
    const timestamp = nowIso();
    if (status === SNAPSHOT_STATUS.CONFIRMED) {
      this.db.prepare("UPDATE snapshots SET status = ?, updated_at = ?, confirmed_by = ?, confirmed_at = ?, revision = revision + 1 WHERE id = ?")
        .run(status, timestamp, String(actorName), timestamp, snapshotId);
    } else {
      this.db.prepare("UPDATE snapshots SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?").run(status, timestamp, snapshotId);
    }
    return this.getSnapshot(snapshotId);
  }

  /** 스냅샷을 변경했음을 기록합니다. 수정 회차를 올려 동시 편집을 판별할 수 있게 합니다. */
  touchSnapshot(snapshotId, timestamp = nowIso()) {
    this.db.prepare("UPDATE snapshots SET updated_at = ?, revision = revision + 1 WHERE id = ?").run(timestamp, snapshotId);
  }

  assertDraftSnapshot(snapshotId) {
    const snapshot = this.db.prepare("SELECT status FROM snapshots WHERE id = ?").get(snapshotId);
    if (!snapshot) throw notFound("집행서 버전을 찾을 수 없습니다.");
    if (snapshot.status !== SNAPSHOT_STATUS.DRAFT) {
      throw conflict("확정된 버전은 수정할 수 없습니다. 새 버전을 만들어 주세요.");
    }
  }

  assertNotStale(snapshotId, expectedRevision) {
    if (expectedRevision === null || expectedRevision === undefined) return;
    const row = this.db.prepare("SELECT revision FROM snapshots WHERE id = ?").get(snapshotId);
    if (!row) throw notFound("집행서 버전을 찾을 수 없습니다.");
    if (Number(row.revision) !== Number(expectedRevision)) {
      throw conflict("다른 사용자가 이 버전을 먼저 저장했습니다. 화면을 새로 고쳐 최신 내용을 확인한 뒤 다시 저장해 주세요.", "STALE");
    }
  }

  // ---------------------------------------------------------------- 입고

  importReceipts(snapshotId, receipts, { replace = false } = {}) {
    const allowedItems = new Set(
      this.db.prepare("SELECT item_code AS itemCode FROM snapshot_items WHERE snapshot_id = ?").all(snapshotId).map((row) => row.itemCode),
    );
    const insert = this.db.prepare(`
      INSERT INTO receipts (snapshot_id, source_key, receipt_no, item_code, item_name, receipt_date, amount, vat_amount, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(snapshot_id, source_key) DO UPDATE SET
        receipt_no = excluded.receipt_no,
        item_code = excluded.item_code,
        item_name = excluded.item_name,
        receipt_date = excluded.receipt_date,
        amount = excluded.amount,
        vat_amount = excluded.vat_amount,
        fetched_at = excluded.fetched_at
    `);
    let importedCount = 0;
    let skippedCount = 0;
    const skippedItemCodes = new Set();
    const fetchedAt = nowIso();

    this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      if (replace) this.db.prepare("DELETE FROM receipts WHERE snapshot_id = ?").run(snapshotId);
      for (const receipt of receipts) {
        if (!allowedItems.has(receipt.itemCode)) {
          skippedCount += 1;
          if (receipt.itemCode) skippedItemCodes.add(receipt.itemCode);
          continue;
        }
        insert.run(
          snapshotId,
          normalizeName(receipt.sourceKey, "입고 원본키", 120),
          String(receipt.receiptNo ?? "").slice(0, 60),
          receipt.itemCode,
          String(receipt.itemName ?? receipt.itemCode).slice(0, 120),
          String(receipt.receiptDate ?? "").slice(0, 20),
          toWon(receipt.amount),
          toWon(receipt.vatAmount),
          fetchedAt,
        );
        importedCount += 1;
      }
      this.touchSnapshot(snapshotId, fetchedAt);
    });

    return {
      importedCount,
      skippedCount,
      skippedItemCodes: [...skippedItemCodes].slice(0, 20),
      snapshot: this.getSnapshot(snapshotId),
    };
  }

  deleteReceipts(snapshotId) {
    return this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      const result = this.db.prepare("DELETE FROM receipts WHERE snapshot_id = ?").run(snapshotId);
      this.touchSnapshot(snapshotId);
      return { deletedCount: result.changes, snapshot: this.getSnapshot(snapshotId) };
    });
  }

  deleteReceipt(snapshotId, receiptId) {
    return this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      const result = this.db.prepare("DELETE FROM receipts WHERE id = ? AND snapshot_id = ?").run(receiptId, snapshotId);
      if (result.changes === 0) throw notFound("입고 내역을 찾을 수 없습니다.");
      this.touchSnapshot(snapshotId);
      return { deletedCount: result.changes, snapshot: this.getSnapshot(snapshotId) };
    });
  }

  listReceipts(snapshotId) {
    return this.db.prepare(`
      SELECT id, source_key AS sourceKey, receipt_no AS receiptNo, item_code AS itemCode,
             item_name AS itemName, receipt_date AS receiptDate, amount, vat_amount AS vatAmount,
             fetched_at AS fetchedAt
      FROM receipts WHERE snapshot_id = ? ORDER BY receipt_date DESC, receipt_no DESC, id DESC
    `).all(snapshotId);
  }

  // ---------------------------------------------------------------- 초기화

  /** 초기화하면 무엇이 지워지는지 미리 보여 주기 위한 집계. */
  countResettableData() {
    const one = (sql) => Number(this.db.prepare(sql).get().count);
    return {
      projects: one("SELECT COUNT(*) AS count FROM projects"),
      snapshots: one("SELECT COUNT(*) AS count FROM snapshots"),
      confirmedSnapshots: one(`SELECT COUNT(*) AS count FROM snapshots WHERE status = '${SNAPSHOT_STATUS.CONFIRMED}'`),
      receipts: one("SELECT COUNT(*) AS count FROM receipts"),
    };
  }

  /**
   * 모든 집행서와 프로젝트를 지웁니다. 되돌릴 수 없습니다.
   * 분류·품번 설정, 사용자, 아마란스10 연동 설정, 활동 기록은 남깁니다.
   */
  resetOperationalData() {
    const before = this.countResettableData();
    this.transaction(() => {
      // snapshots 는 projects 에 ON DELETE CASCADE 로 물려 있고,
      // snapshot_lines / snapshot_items / receipts 는 다시 snapshots 에 물려 있습니다.
      this.db.exec("DELETE FROM snapshots");
      this.db.exec("DELETE FROM projects");
    });
    const after = this.countResettableData();
    if (after.projects !== 0 || after.snapshots !== 0 || after.receipts !== 0) {
      throw new Error("초기화 후에도 자료가 남아 있습니다.");
    }
    return before;
  }

  close() {
    this.db.close();
  }
}

export { AUDIT_ACTION };
