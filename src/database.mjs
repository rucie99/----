import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { calculateBudget, calculateSummary, toWon } from "./calculations.mjs";
import { AMARANCE_MODE, AMARANCE_SETTING_KEY, PROJECT_STATUS, SNAPSHOT_STATUS } from "./constants.mjs";

function nowIso() {
  return new Date().toISOString();
}

function normalizeName(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${fieldName}을(를) 입력해 주세요.`);
  }
  return normalized;
}

export class AppDatabase {
  constructor(databasePath) {
    const resolvedPath = databasePath === ":memory:" ? databasePath : resolve(databasePath);
    if (resolvedPath !== ":memory:") {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }
    this.db = new DatabaseSync(resolvedPath);
    this.db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.initialize();
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS major_categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1
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
        middle_category_id INTEGER NOT NULL REFERENCES middle_categories(id) ON DELETE CASCADE,
        item_code TEXT NOT NULL UNIQUE,
        item_name TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_snapshot_lines_snapshot ON snapshot_lines(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_snapshot_items_line ON snapshot_items(snapshot_line_id);
      CREATE INDEX IF NOT EXISTS idx_receipts_snapshot_item ON receipts(snapshot_id, item_code);
    `);
    this.seedDemoData();
  }

  initializeAmaranceSettings(settings) {
    const current = this.db.prepare("SELECT COUNT(*) AS count FROM app_settings WHERE setting_key = ?").get(AMARANCE_SETTING_KEY.MODE);
    if (Number(current.count) > 0) return this.getAmaranceSettings();
    return this.saveAmaranceSettings(settings);
  }

  getAmaranceSettings() {
    const rows = this.db.prepare("SELECT setting_key AS settingKey, setting_value AS settingValue FROM app_settings").all();
    const values = new Map(rows.map((row) => [row.settingKey, row.settingValue]));
    return {
      mode: values.get(AMARANCE_SETTING_KEY.MODE) || AMARANCE_MODE.DEMO,
      baseUrl: values.get(AMARANCE_SETTING_KEY.BASE_URL) || "",
      companyCode: values.get(AMARANCE_SETTING_KEY.COMPANY_CODE) || "",
      callerName: values.get(AMARANCE_SETTING_KEY.CALLER_NAME) || "",
      accessToken: values.get(AMARANCE_SETTING_KEY.ACCESS_TOKEN) || "",
      hashKey: values.get(AMARANCE_SETTING_KEY.HASH_KEY) || "",
      groupSeq: values.get(AMARANCE_SETTING_KEY.GROUP_SEQ) || "",
    };
  }

  saveAmaranceSettings(settings) {
    const normalized = {
      [AMARANCE_SETTING_KEY.MODE]: String(settings.mode || AMARANCE_MODE.DEMO).toUpperCase(),
      [AMARANCE_SETTING_KEY.BASE_URL]: String(settings.baseUrl || "").trim().replace(/\/$/, ""),
      [AMARANCE_SETTING_KEY.COMPANY_CODE]: String(settings.companyCode || "").trim(),
      [AMARANCE_SETTING_KEY.CALLER_NAME]: String(settings.callerName || "").trim(),
      [AMARANCE_SETTING_KEY.ACCESS_TOKEN]: String(settings.accessToken || ""),
      [AMARANCE_SETTING_KEY.HASH_KEY]: String(settings.hashKey || ""),
      [AMARANCE_SETTING_KEY.GROUP_SEQ]: String(settings.groupSeq || "").trim(),
    };
    const upsert = this.db.prepare(`
      INSERT INTO app_settings (setting_key, setting_value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(setting_key) DO UPDATE SET
        setting_value = excluded.setting_value,
        updated_at = excluded.updated_at
    `);
    const updatedAt = nowIso();
    this.transaction(() => {
      for (const [key, value] of Object.entries(normalized)) upsert.run(key, value, updatedAt);
    });
    return this.getAmaranceSettings();
  }

  seedDemoData() {
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM major_categories").get().count;
    if (count > 0) {
      return;
    }

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

    this.transaction(() => {
      const insertMajor = this.db.prepare("INSERT INTO major_categories (name, sort_order) VALUES (?, ?)");
      const insertMiddle = this.db.prepare("INSERT INTO middle_categories (major_category_id, name, sort_order) VALUES (?, ?, ?)");
      const middleIds = new Map();
      demoCategories.forEach(([majorName, middleNames], majorIndex) => {
        const majorId = Number(insertMajor.run(majorName, majorIndex + 1).lastInsertRowid);
        middleNames.forEach((middleName, middleIndex) => {
          const middleId = Number(insertMiddle.run(majorId, middleName, middleIndex + 1).lastInsertRowid);
          middleIds.set(middleName, middleId);
        });
      });
      const insertItem = this.db.prepare("INSERT INTO item_mappings (middle_category_id, item_code, item_name) VALUES (?, ?, ?)");
      for (const [middleName, itemCode, itemName] of demoItems) {
        insertItem.run(middleIds.get(middleName), itemCode, itemName);
      }
    });
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listCategories() {
    const majors = this.db.prepare("SELECT id, name, sort_order AS sortOrder FROM major_categories WHERE is_active = 1 ORDER BY sort_order, id").all();
    const middles = this.db.prepare("SELECT id, major_category_id AS majorCategoryId, name, sort_order AS sortOrder FROM middle_categories WHERE is_active = 1 ORDER BY sort_order, id").all();
    const items = this.db.prepare("SELECT id, middle_category_id AS middleCategoryId, item_code AS itemCode, item_name AS itemName FROM item_mappings ORDER BY item_code").all();
    return majors.map((major) => ({
      ...major,
      middleCategories: middles.filter((middle) => middle.majorCategoryId === major.id).map((middle) => ({
        ...middle,
        items: items.filter((item) => item.middleCategoryId === middle.id),
      })),
    }));
  }

  createMajorCategory(data) {
    const name = normalizeName(data.name, "대분류명");
    const sortOrder = Number(data.sortOrder) || 0;
    const result = this.db.prepare("INSERT INTO major_categories (name, sort_order) VALUES (?, ?)").run(name, sortOrder);
    return { id: Number(result.lastInsertRowid), name, sortOrder };
  }

  updateMajorCategory(id, data) {
    const name = normalizeName(data.name, "대분류명");
    const result = this.db.prepare("UPDATE major_categories SET name = ?, sort_order = ? WHERE id = ?").run(name, Number(data.sortOrder) || 0, id);
    if (result.changes === 0) throw new Error("대분류를 찾을 수 없습니다.");
  }

  deleteMajorCategory(id) {
    const result = this.db.prepare("DELETE FROM major_categories WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("대분류를 찾을 수 없습니다.");
  }

  createMiddleCategory(data) {
    const name = normalizeName(data.name, "중분류명");
    const majorCategoryId = Number(data.majorCategoryId);
    const result = this.db.prepare("INSERT INTO middle_categories (major_category_id, name, sort_order) VALUES (?, ?, ?)").run(majorCategoryId, name, Number(data.sortOrder) || 0);
    return { id: Number(result.lastInsertRowid), majorCategoryId, name };
  }

  updateMiddleCategory(id, data) {
    const name = normalizeName(data.name, "중분류명");
    const result = this.db.prepare("UPDATE middle_categories SET major_category_id = ?, name = ?, sort_order = ? WHERE id = ?").run(Number(data.majorCategoryId), name, Number(data.sortOrder) || 0, id);
    if (result.changes === 0) throw new Error("중분류를 찾을 수 없습니다.");
  }

  deleteMiddleCategory(id) {
    const result = this.db.prepare("DELETE FROM middle_categories WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("중분류를 찾을 수 없습니다.");
  }

  createItemMapping(data) {
    const middleCategoryId = Number(data.middleCategoryId);
    const itemCode = normalizeName(data.itemCode, "품번");
    const itemName = normalizeName(data.itemName, "품명");
    const result = this.db.prepare("INSERT INTO item_mappings (middle_category_id, item_code, item_name) VALUES (?, ?, ?)").run(middleCategoryId, itemCode, itemName);
    return { id: Number(result.lastInsertRowid), middleCategoryId, itemCode, itemName };
  }

  deleteItemMapping(id) {
    const result = this.db.prepare("DELETE FROM item_mappings WHERE id = ?").run(id);
    if (result.changes === 0) throw new Error("품번 연결을 찾을 수 없습니다.");
  }

  upsertProjects(projects) {
    const statement = this.db.prepare(`
      INSERT INTO projects (code, name, contract_amount, status, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        name = excluded.name,
        contract_amount = excluded.contract_amount,
        status = excluded.status,
        synced_at = excluded.synced_at
    `);
    const syncedAt = nowIso();
    this.transaction(() => {
      for (const project of projects) {
        statement.run(
          normalizeName(project.code, "프로젝트코드"),
          normalizeName(project.name, "프로젝트명"),
          toWon(project.contractAmount),
          project.status || PROJECT_STATUS.ACTIVE,
          syncedAt,
        );
      }
    });
    return this.listProjects();
  }

  listProjects() {
    return this.db.prepare(`
      SELECT id, code, name, contract_amount AS contractAmount, status, synced_at AS syncedAt
      FROM projects
      ORDER BY CASE status WHEN '${PROJECT_STATUS.ACTIVE}' THEN 0 ELSE 1 END, code DESC
    `).all();
  }

  listSnapshots(projectId) {
    return this.db.prepare(`
      SELECT id, project_id AS projectId, version_no AS versionNo, title, status,
             created_at AS createdAt, updated_at AS updatedAt
      FROM snapshots WHERE project_id = ? ORDER BY version_no DESC
    `).all(projectId);
  }

  createSnapshot(projectId, options = {}) {
    const project = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
    if (!project) throw new Error("프로젝트를 찾을 수 없습니다.");
    const versionNo = Number(this.db.prepare("SELECT COALESCE(MAX(version_no), 0) + 1 AS versionNo FROM snapshots WHERE project_id = ?").get(projectId).versionNo);
    const createdAt = nowIso();

    return this.transaction(() => {
      const snapshotResult = this.db.prepare(`
        INSERT INTO snapshots (project_id, version_no, title, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(projectId, versionNo, `버전 ${versionNo}`, SNAPSHOT_STATUS.DRAFT, createdAt, createdAt);
      const snapshotId = Number(snapshotResult.lastInsertRowid);

      if (options.cloneSnapshotId) {
        this.cloneSnapshotLines(snapshotId, Number(options.cloneSnapshotId));
      } else {
        this.captureCurrentCategories(snapshotId);
      }
      return this.getSnapshot(snapshotId);
    });
  }

  captureCurrentCategories(snapshotId) {
    const categories = this.listCategories();
    const insertLine = this.db.prepare(`
      INSERT INTO snapshot_lines (snapshot_id, major_name, middle_name, major_sort, middle_sort)
      VALUES (?, ?, ?, ?, ?)
    `);
    const insertItem = this.db.prepare("INSERT INTO snapshot_items (snapshot_line_id, item_code, item_name) VALUES (?, ?, ?)");
    for (const major of categories) {
      for (const middle of major.middleCategories) {
        const lineId = Number(insertLine.run(snapshotId, major.name, middle.name, major.sortOrder, middle.sortOrder).lastInsertRowid);
        for (const item of middle.items) {
          insertItem.run(lineId, item.itemCode, item.itemName);
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
    if (!source) throw new Error("복제할 스냅샷을 찾을 수 없습니다.");
    const sourceLines = this.db.prepare("SELECT * FROM snapshot_lines WHERE snapshot_id = ? ORDER BY major_sort, middle_sort, id").all(sourceSnapshotId);
    const insertLine = this.db.prepare(`
      INSERT INTO snapshot_lines (snapshot_id, major_name, middle_name, major_sort, middle_sort, execution_budget, remark)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const sourceItems = this.db.prepare("SELECT item_code, item_name FROM snapshot_items WHERE snapshot_line_id = ? ORDER BY id");
    const insertItem = this.db.prepare("INSERT INTO snapshot_items (snapshot_line_id, item_code, item_name) VALUES (?, ?, ?)");
    for (const line of sourceLines) {
      const lineId = Number(insertLine.run(snapshotId, line.major_name, line.middle_name, line.major_sort, line.middle_sort, line.execution_budget, line.remark).lastInsertRowid);
      for (const item of sourceItems.all(line.id)) {
        insertItem.run(lineId, item.item_code, item.item_name);
      }
    }
  }

  getSnapshot(snapshotId) {
    const snapshot = this.db.prepare(`
      SELECT s.id, s.project_id AS projectId, s.version_no AS versionNo, s.title, s.status,
             s.created_at AS createdAt, s.updated_at AS updatedAt,
             p.code AS projectCode, p.name AS projectName, p.contract_amount AS contractAmount
      FROM snapshots s JOIN projects p ON p.id = s.project_id WHERE s.id = ?
    `).get(snapshotId);
    if (!snapshot) throw new Error("스냅샷을 찾을 수 없습니다.");

    const lines = this.db.prepare(`
      SELECT id, major_name AS majorName, middle_name AS middleName,
             execution_budget AS executionBudget, remark
      FROM snapshot_lines WHERE snapshot_id = ? ORDER BY major_sort, middle_sort, id
    `).all(snapshotId);
    const items = this.db.prepare(`
      SELECT si.snapshot_line_id AS snapshotLineId, si.item_code AS itemCode, si.item_name AS itemName
      FROM snapshot_items si JOIN snapshot_lines sl ON sl.id = si.snapshot_line_id
      WHERE sl.snapshot_id = ? ORDER BY si.item_code
    `).all(snapshotId);
    const purchases = this.db.prepare(`
      SELECT si.snapshot_line_id AS snapshotLineId, COALESCE(SUM(r.amount), 0) AS purchaseAmount
      FROM snapshot_items si
      JOIN snapshot_lines sl ON sl.id = si.snapshot_line_id
      LEFT JOIN receipts r ON r.snapshot_id = sl.snapshot_id AND r.item_code = si.item_code
      WHERE sl.snapshot_id = ? GROUP BY si.snapshot_line_id
    `).all(snapshotId);
    const purchaseByLine = new Map(purchases.map((row) => [row.snapshotLineId, Number(row.purchaseAmount)]));
    const enrichedLines = lines.map((line) => ({
      ...line,
      items: items.filter((item) => item.snapshotLineId === line.id).map(({ itemCode, itemName }) => ({ itemCode, itemName })),
      ...calculateBudget(line.executionBudget, purchaseByLine.get(line.id) || 0),
    }));
    const purchaseAmount = enrichedLines.reduce((sum, line) => sum + line.purchaseAmount, 0);
    const executionBudget = enrichedLines.reduce((sum, line) => sum + line.executionBudget, 0);
    return {
      ...snapshot,
      lines: enrichedLines,
      totals: {
        ...calculateSummary(snapshot.contractAmount, purchaseAmount),
        executionBudget,
        budgetBalance: executionBudget - purchaseAmount,
      },
      receipts: this.listReceipts(snapshotId),
    };
  }

  updateSnapshotLine(snapshotId, lineId, data) {
    return this.updateSnapshotLines(snapshotId, [{ id: lineId, ...data }]);
  }

  updateSnapshotLines(snapshotId, lines) {
    if (!Array.isArray(lines)) throw new Error("저장할 집행서 항목이 올바르지 않습니다.");
    const update = this.db.prepare(`
      UPDATE snapshot_lines SET execution_budget = ?, remark = ? WHERE id = ? AND snapshot_id = ?
    `);
    const lineIds = new Set();

    this.transaction(() => {
      this.assertDraftSnapshot(snapshotId);
      for (const line of lines) {
        const lineId = Number(line.id);
        if (!Number.isInteger(lineId) || lineId <= 0 || lineIds.has(lineId)) {
          throw new Error("저장할 집행서 항목이 올바르지 않습니다.");
        }
        lineIds.add(lineId);
        const result = update.run(
          Math.max(0, toWon(line.executionBudget)),
          String(line.remark ?? "").trim(),
          lineId,
          snapshotId,
        );
        if (result.changes === 0) throw new Error("집행서 항목을 찾을 수 없습니다.");
      }
      if (lines.length > 0) this.db.prepare("UPDATE snapshots SET updated_at = ? WHERE id = ?").run(nowIso(), snapshotId);
    });
    return this.getSnapshot(snapshotId);
  }

  setSnapshotStatus(snapshotId, status) {
    if (!Object.values(SNAPSHOT_STATUS).includes(status)) throw new Error("올바르지 않은 스냅샷 상태입니다.");
    const current = this.db.prepare("SELECT status FROM snapshots WHERE id = ?").get(snapshotId);
    if (!current) throw new Error("스냅샷을 찾을 수 없습니다.");
    if (current.status === SNAPSHOT_STATUS.CONFIRMED && status !== SNAPSHOT_STATUS.CONFIRMED) {
      throw new Error("확정된 버전은 변경할 수 없습니다. 새 버전을 만들어 주세요.");
    }
    const result = this.db.prepare("UPDATE snapshots SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), snapshotId);
    return this.getSnapshot(snapshotId);
  }

  assertDraftSnapshot(snapshotId) {
    const snapshot = this.db.prepare("SELECT status FROM snapshots WHERE id = ?").get(snapshotId);
    if (!snapshot) throw new Error("스냅샷을 찾을 수 없습니다.");
    if (snapshot.status !== SNAPSHOT_STATUS.DRAFT) throw new Error("확정된 버전은 수정할 수 없습니다. 새 버전을 만들어 주세요.");
  }

  importReceipts(snapshotId, receipts) {
    this.assertDraftSnapshot(snapshotId);
    const allowedItems = new Set(this.db.prepare(`
      SELECT si.item_code AS itemCode FROM snapshot_items si
      JOIN snapshot_lines sl ON sl.id = si.snapshot_line_id WHERE sl.snapshot_id = ?
    `).all(snapshotId).map((row) => row.itemCode));
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
    const fetchedAt = nowIso();
    this.transaction(() => {
      for (const receipt of receipts) {
        if (!allowedItems.has(receipt.itemCode)) continue;
        insert.run(
          snapshotId,
          normalizeName(receipt.sourceKey, "입고 원본키"),
          String(receipt.receiptNo ?? ""),
          receipt.itemCode,
          String(receipt.itemName ?? receipt.itemCode),
          String(receipt.receiptDate ?? ""),
          toWon(receipt.amount),
          toWon(receipt.vatAmount),
          fetchedAt,
        );
        importedCount += 1;
      }
      this.db.prepare("UPDATE snapshots SET updated_at = ? WHERE id = ?").run(fetchedAt, snapshotId);
    });
    return { importedCount, snapshot: this.getSnapshot(snapshotId) };
  }

  listReceipts(snapshotId) {
    return this.db.prepare(`
      SELECT id, source_key AS sourceKey, receipt_no AS receiptNo, item_code AS itemCode,
             item_name AS itemName, receipt_date AS receiptDate, amount, vat_amount AS vatAmount,
             fetched_at AS fetchedAt
      FROM receipts WHERE snapshot_id = ? ORDER BY receipt_date DESC, receipt_no DESC, id DESC
    `).all(snapshotId);
  }

  close() {
    this.db.close();
  }
}
