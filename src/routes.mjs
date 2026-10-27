import {
  AUDIT_ACTION,
  MAX_ITEM_SEARCH_RESULTS,
  RESET_CONFIRM_PHRASE,
  SNAPSHOT_STATUS,
  USER_ROLE,
  USER_ROLE_LABEL,
} from "./constants.mjs";
import { assertRole, hasRole } from "./auth.mjs";
import { badRequest, conflict, forbidden, notFound } from "./errors.mjs";
import { normalizeDateRange } from "./amarance-client.mjs";
import { assertPasswordPolicy, generateReadablePassword, hashPassword, verifyPassword } from "./passwords.mjs";
import { readJson, sendJson, sendNoContent, sendBuffer } from "./http.mjs";
import { createSnapshotWorkbook } from "./xlsx-export.mjs";
import { CONTENT_TYPE } from "./constants.mjs";

function positiveInteger(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw badRequest(`${fieldName}이(가) 올바르지 않습니다.`);
  return parsed;
}

/**
 * 라우트 정의.
 * role 이 null 이면 로그인 없이 호출할 수 있습니다.
 * 그 밖에는 최소 권한을 지정하고, 서버가 요청 처리 전에 검사합니다.
 */
export function createRoutes() {
  return [
    // ------------------------------------------------------------ 인증
    {
      method: "GET",
      pattern: /^\/api\/session$/,
      role: null,
      async handle(context) {
        sendJson(context.response, 200, context.user
          ? { authenticated: true, user: context.database.publicUser(context.user), csrfToken: context.session.csrfToken }
          : { authenticated: false });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/auth\/login$/,
      role: null,
      async handle(context) {
        const body = await readJson(context.request);
        const { user, session } = context.auth.login(body.loginId, body.password, {
          ip: context.ip,
          userAgent: context.request.headers["user-agent"],
        });
        context.startSession(session);
        context.database.recordAudit({ actor: user, action: AUDIT_ACTION.LOGIN, ip: context.ip });
        context.logger.info("로그인", { loginId: user.loginId, ip: context.ip });
        sendJson(context.response, 200, {
          user: context.database.publicUser(user),
          csrfToken: session.csrfToken,
        }, context.pendingCookieHeader());
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/auth\/logout$/,
      role: null,
      async handle(context) {
        if (context.user) {
          context.database.recordAudit({ actor: context.user, action: AUDIT_ACTION.LOGOUT, ip: context.ip });
        }
        context.auth.logout(context.session?.id);
        context.endSession();
        sendJson(context.response, 200, { ok: true }, context.pendingCookieHeader());
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/auth\/password$/,
      role: USER_ROLE.VIEWER,
      async handle(context) {
        const body = await readJson(context.request);
        const stored = context.database.getUser(context.user.id);
        if (stored.hasPassword && !verifyPassword(String(body.currentPassword ?? ""), stored.passwordHash)) {
          throw badRequest("현재 비밀번호가 올바르지 않습니다.");
        }
        let nextPassword;
        try {
          nextPassword = assertPasswordPolicy(body.newPassword);
        } catch (error) {
          throw badRequest(error.message);
        }
        if (stored.hasPassword && verifyPassword(nextPassword, stored.passwordHash)) {
          throw badRequest("이전과 다른 비밀번호를 사용해 주세요.");
        }
        context.database.setUserPassword(context.user.id, hashPassword(nextPassword), { mustChangePassword: false });
        // 비밀번호를 바꾸면 다른 기기의 세션은 모두 끊고, 지금 쓰는 세션만 새로 발급합니다.
        context.auth.logoutAllForUser(context.user.id);
        const session = context.auth.createSession(context.user, {
          ip: context.ip,
          userAgent: context.request.headers["user-agent"],
        });
        context.startSession(session);
        context.database.recordAudit({ actor: context.user, action: AUDIT_ACTION.PASSWORD_CHANGED, ip: context.ip });
        sendJson(context.response, 200, { ok: true, csrfToken: session.csrfToken }, context.pendingCookieHeader());
      },
    },

    // ------------------------------------------------------------ 기초 조회
    {
      method: "GET",
      pattern: /^\/api\/bootstrap$/,
      role: USER_ROLE.VIEWER,
      async handle(context) {
        const security = context.database.getSecuritySettings();
        sendJson(context.response, 200, {
          appName: context.appName,
          buildInfo: context.buildInfo,
          user: context.database.publicUser(context.user),
          csrfToken: context.session.csrfToken,
          permissions: {
            canEdit: hasRole(context.user, USER_ROLE.EDITOR),
            canAdminister: hasRole(context.user, USER_ROLE.ADMIN),
          },
          categories: context.database.listCategories(),
          categorySets: context.database.listCategorySets(),
          projects: context.database.listProjects(),
          amarance: context.amarance.getConfiguration(),
          receiptMaxRangeDays: security.receiptMaxRangeDays,
          sessionIdleMinutes: security.sessionIdleMinutes,
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/categories$/,
      role: USER_ROLE.VIEWER,
      async handle(context) {
        const requested = context.url.searchParams.get("categorySetId");
        sendJson(context.response, 200, context.database.listCategories(requested ? Number(requested) : null));
      },
    },

    // ------------------------------------------------------------ 분류 설정 버전(관리자)
    {
      method: "GET",
      pattern: /^\/api\/category-sets$/,
      role: USER_ROLE.VIEWER,
      async handle(context) {
        sendJson(context.response, 200, context.database.listCategorySets());
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/category-sets$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        const created = context.database.createCategorySet({
          title: body.title,
          cloneFromId: body.cloneFromId ? positiveInteger(body.cloneFromId, "복제할 설정 버전 ID") : null,
          createdBy: context.user.name,
        });
        context.audit(AUDIT_ACTION.CATEGORY_SET_CREATED, "CATEGORY_SET", created.id,
          `v${created.versionNo} ${created.title}${body.cloneFromId ? " (복제)" : ""}`);
        sendJson(context.response, 201, { set: created, sets: context.database.listCategorySets() });
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/category-sets\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "설정 버전 ID");
        const body = await readJson(context.request);
        const updated = context.database.renameCategorySet(id, body.title);
        context.audit(AUDIT_ACTION.CATEGORY_SET_RENAMED, "CATEGORY_SET", id, `이름 변경: ${updated.title}`);
        sendJson(context.response, 200, { set: updated, sets: context.database.listCategorySets() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/category-sets\/(\d+)\/current$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "설정 버전 ID");
        const updated = context.database.setCurrentCategorySet(id);
        context.audit(AUDIT_ACTION.CATEGORY_SET_ACTIVATED, "CATEGORY_SET", id, `사용 중으로 지정: v${updated.versionNo} ${updated.title}`);
        sendJson(context.response, 200, { set: updated, sets: context.database.listCategorySets() });
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/category-sets\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "설정 버전 ID");
        const removed = context.database.deleteCategorySet(id);
        context.audit(AUDIT_ACTION.CATEGORY_SET_DELETED, "CATEGORY_SET", id, `v${removed.versionNo} ${removed.title}`);
        sendJson(context.response, 200, { sets: context.database.listCategorySets() });
      },
    },

    // ------------------------------------------------------------ 전체 초기화(관리자)
    {
      method: "GET",
      pattern: /^\/api\/admin\/reset$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        sendJson(context.response, 200, {
          counts: context.database.countResettableData(),
          confirmPhrase: RESET_CONFIRM_PHRASE,
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/admin\/reset$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        // 실수로 한 번에 실행되지 않도록, 확인 문구를 그대로 입력해야만 진행합니다.
        if (String(body.confirm ?? "").trim() !== RESET_CONFIRM_PHRASE) {
          throw badRequest(`초기화를 진행하려면 확인란에 '${RESET_CONFIRM_PHRASE}' 를 정확히 입력해 주세요.`);
        }
        const removed = context.database.resetOperationalData();
        context.audit(AUDIT_ACTION.DATA_RESET, "SYSTEM", "",
          `집행서 ${removed.snapshots}건(확정 ${removed.confirmedSnapshots}건) · 입고 ${removed.receipts}건 · 프로젝트 ${removed.projects}건 삭제`);
        context.logger.warn("업무 데이터를 초기화했습니다.", { loginId: context.user.loginId, removed });
        sendJson(context.response, 200, {
          removed,
          projects: context.database.listProjects(),
        });
      },
    },

    // ------------------------------------------------------------ 분류 관리(관리자)
    {
      method: "POST",
      pattern: /^\/api\/major-categories$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const created = context.database.createMajorCategory(await readJson(context.request));
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MAJOR", created.id,
          `대분류 추가: ${created.name} (설정 세트 ${created.categorySetId})`);
        sendJson(context.response, 201, created);
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/major-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "대분류 ID");
        const body = await readJson(context.request);
        context.database.updateMajorCategory(id, body);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MAJOR", id, `대분류 수정: ${body.name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/major-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "대분류 ID");
        const name = context.database.deleteMajorCategory(id);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MAJOR", id, `대분류 삭제: ${name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/major-categories\/(\d+)\/move$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "대분류 ID");
        const body = await readJson(context.request);
        const direction = body.direction === "up" ? "up" : "down";
        const moved = context.database.moveCategory("major", id, direction);
        if (moved) context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MAJOR", id, `대분류 순서 이동: ${direction}`);
        sendJson(context.response, 200, { moved, categories: context.database.listCategories() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/middle-categories$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const created = context.database.createMiddleCategory(await readJson(context.request));
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MIDDLE", created.id, `중분류 추가: ${created.name}`);
        sendJson(context.response, 201, created);
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/middle-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "중분류 ID");
        const body = await readJson(context.request);
        context.database.updateMiddleCategory(id, body);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MIDDLE", id, `중분류 수정: ${body.name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/middle-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "중분류 ID");
        const name = context.database.deleteMiddleCategory(id);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MIDDLE", id, `중분류 삭제: ${name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/middle-categories\/(\d+)\/move$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "중분류 ID");
        const body = await readJson(context.request);
        const direction = body.direction === "up" ? "up" : "down";
        const moved = context.database.moveCategory("middle", id, direction);
        if (moved) context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MIDDLE", id, `중분류 순서 이동: ${direction}`);
        sendJson(context.response, 200, { moved, categories: context.database.listCategories() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/minor-categories$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const created = context.database.createMinorCategory(await readJson(context.request));
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MINOR", created.id,
          `소분류 추가: ${created.name}${created.movedItemCount ? ` (중분류 품번 ${created.movedItemCount}건 이동)` : ""}`);
        sendJson(context.response, 201, created);
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/minor-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "소분류 ID");
        const body = await readJson(context.request);
        context.database.updateMinorCategory(id, body);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MINOR", id, `소분류 수정: ${body.name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/minor-categories\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "소분류 ID");
        const name = context.database.deleteMinorCategory(id);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MINOR", id, `소분류 삭제: ${name}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/minor-categories\/(\d+)\/move$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "소분류 ID");
        const body = await readJson(context.request);
        const direction = body.direction === "up" ? "up" : "down";
        const moved = context.database.moveCategory("minor", id, direction);
        if (moved) context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "MINOR", id, `소분류 순서 이동: ${direction}`);
        sendJson(context.response, 200, { moved, categories: context.database.listCategories() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/item-mappings$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const created = context.database.createItemMapping(await readJson(context.request));
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "ITEM", created.id, `품번 연결: ${created.itemCode}`);
        sendJson(context.response, 201, created);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/item-mappings\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "품번 연결 ID");
        const itemCode = context.database.deleteItemMapping(id);
        context.audit(AUDIT_ACTION.CATEGORY_CHANGED, "ITEM", id, `품번 연결 해제: ${itemCode}`);
        sendNoContent(context.response);
      },
    },

    // ------------------------------------------------------------ 아마란스10
    {
      method: "POST",
      pattern: /^\/api\/amarance\/items\/search$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        const items = await context.amarance.searchItems(String(body.query ?? "").slice(0, 100));
        const mapped = new Map(context.database
          .listMappedItemCodes(body.categorySetId ? Number(body.categorySetId) : null)
          .map((row) => [row.itemCode, row]));
        sendJson(context.response, 200, {
          truncated: items.length >= MAX_ITEM_SEARCH_RESULTS,
          items: items.slice(0, MAX_ITEM_SEARCH_RESULTS).map((item) => ({
            ...item,
            mappedTo: mapped.has(item.itemCode)
              ? [mapped.get(item.itemCode).majorName, mapped.get(item.itemCode).middleName, mapped.get(item.itemCode).minorName]
                .filter(Boolean).join(" 〉 ")
              : null,
          })),
        });
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/amarance\/settings$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        sendJson(context.response, 200, {
          amarance: context.amarance.getConfiguration(),
          sso: context.database.getSsoSettings(),
          security: context.database.getSecuritySettings(),
        });
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/amarance\/settings$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        const current = context.database.getAmaranceSettings();
        const next = {
          mode: body.mode,
          baseUrl: body.baseUrl,
          companyCode: body.companyCode,
          callerName: body.callerName,
          groupSeq: body.groupSeq,
          accessToken: body.clearAccessToken ? "" : String(body.accessToken || current.accessToken),
          hashKey: body.clearHashKey ? "" : String(body.hashKey || current.hashKey),
        };
        context.applyAmaranceSettings(next);
        context.audit(AUDIT_ACTION.AMARANCE_SETTINGS_SAVED, "SETTINGS", "AMARANCE", `모드: ${next.mode}`);
        sendJson(context.response, 200, { amarance: context.amarance.getConfiguration() });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/amarance\/settings\/test$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const projects = await context.amarance.searchProjects();
        sendJson(context.response, 200, {
          mode: context.amarance.getConfiguration().mode,
          projectCount: projects.length,
          message: `프로젝트 조회에 성공했습니다. ${projects.length.toLocaleString("ko-KR")}건을 확인했습니다.`,
        });
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/security\/settings$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        const sso = context.database.saveSsoSettings(body.sso || {});
        const security = context.database.saveSecuritySettings(body.security || {});
        context.audit(AUDIT_ACTION.SECURITY_SETTINGS_SAVED, "SETTINGS", "SECURITY",
          `SSO ${sso.enabled ? "사용" : "미사용"} / 서명 ${sso.signatureMode}`);
        sendJson(context.response, 200, { sso, security });
      },
    },

    // ------------------------------------------------------------ 프로젝트
    {
      method: "POST",
      pattern: /^\/api\/projects\/sync$/,
      role: USER_ROLE.EDITOR,
      async handle(context) {
        const fetched = await context.amarance.searchProjects();
        const { projects, summary } = context.database.upsertProjects(fetched, { reconcile: true });
        context.audit(AUDIT_ACTION.PROJECT_SYNCED, "PROJECT", "",
          `수신 ${summary.received} · 추가 ${summary.created} · 갱신 ${summary.updated} · 보관 ${summary.archived} · 삭제 ${summary.removed}`);
        if (summary.received === 0) {
          context.logger.warn("아마란스10 프로젝트 조회 결과가 0건입니다.", {
            mode: context.amarance.getConfiguration().mode,
            companyCode: context.amarance.getConfiguration().companyCode,
          });
        }
        sendJson(context.response, 200, { projects, summary });
      },
    },

    // ------------------------------------------------------------ 스냅샷
    {
      method: "GET",
      pattern: /^\/api\/projects\/(\d+)\/snapshots$/,
      role: USER_ROLE.VIEWER,
      async handle(context, [rawId]) {
        sendJson(context.response, 200, context.database.listSnapshots(positiveInteger(rawId, "프로젝트 ID")));
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/projects\/(\d+)\/snapshots$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const projectId = positiveInteger(rawId, "프로젝트 ID");
        const body = await readJson(context.request);
        const snapshot = context.database.createSnapshot(projectId, {
          cloneSnapshotId: body.cloneSnapshotId ? positiveInteger(body.cloneSnapshotId, "복제 버전 ID") : null,
          categorySetId: body.categorySetId ? positiveInteger(body.categorySetId, "설정 버전 ID") : null,
          title: body.title,
          createdBy: context.user.name,
        });
        context.audit(AUDIT_ACTION.SNAPSHOT_CREATED, "SNAPSHOT", snapshot.id,
          `${snapshot.projectCode} v${snapshot.versionNo}${body.cloneSnapshotId ? " (복제)" : ""} · 설정 ${snapshot.categorySetLabel || "-"}`);
        sendJson(context.response, 201, snapshot);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/snapshots\/(\d+)$/,
      role: USER_ROLE.VIEWER,
      async handle(context, [rawId]) {
        sendJson(context.response, 200, context.database.getSnapshot(positiveInteger(rawId, "버전 ID")));
      },
    },
    {
      method: "PATCH",
      pattern: /^\/api\/snapshots\/(\d+)$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "버전 ID");
        const body = await readJson(context.request);
        const snapshot = context.database.renameSnapshot(id, body.title);
        context.audit(AUDIT_ACTION.SNAPSHOT_RENAMED, "SNAPSHOT", id, `이름 변경: ${snapshot.title}`);
        sendJson(context.response, 200, snapshot);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/snapshots\/(\d+)$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "버전 ID");
        const snapshot = context.database.deleteSnapshot(id);
        context.audit(AUDIT_ACTION.SNAPSHOT_DELETED, "SNAPSHOT", id, `v${snapshot.versionNo} ${snapshot.title}`);
        sendNoContent(context.response);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/snapshots\/(\d+)\/export\.xlsx$/,
      role: USER_ROLE.VIEWER,
      async handle(context, [rawId]) {
        const snapshot = context.database.getSnapshot(positiveInteger(rawId, "버전 ID"));
        const filename = `기성집행서_${snapshot.projectCode}_v${snapshot.versionNo}.xlsx`;
        const workbook = createSnapshotWorkbook(snapshot);
        context.audit(AUDIT_ACTION.EXPORTED, "SNAPSHOT", snapshot.id, `Excel 내보내기 v${snapshot.versionNo}`);
        const encodedFilename = encodeURIComponent(filename).replaceAll("'", "%27");
        sendBuffer(context.response, 200, workbook, {
          "Content-Type": CONTENT_TYPE.XLSX,
          "Content-Disposition": `attachment; filename="progress-statement.xlsx"; filename*=UTF-8''${encodedFilename}`,
          "Cache-Control": "no-store",
        });
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/snapshots\/(\d+)\/lines$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "버전 ID");
        const body = await readJson(context.request);
        const snapshot = context.database.updateSnapshotLines(id, body.lines, {
          expectedRevision: body.expectedRevision ?? null,
        });
        context.audit(AUDIT_ACTION.SNAPSHOT_UPDATED, "SNAPSHOT", id, `${body.lines?.length ?? 0}개 항목 저장`);
        sendJson(context.response, 200, snapshot);
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/snapshots\/(\d+)\/lines\/(\d+)$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawSnapshotId, rawLineId]) {
        const snapshotId = positiveInteger(rawSnapshotId, "버전 ID");
        const lineId = positiveInteger(rawLineId, "항목 ID");
        const body = await readJson(context.request);
        const snapshot = context.database.updateSnapshotLine(snapshotId, lineId, body);
        context.audit(AUDIT_ACTION.SNAPSHOT_UPDATED, "SNAPSHOT", snapshotId, `항목 ${lineId} 저장`);
        sendJson(context.response, 200, snapshot);
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/snapshots\/(\d+)\/status$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "버전 ID");
        const body = await readJson(context.request);
        if (body.status !== SNAPSHOT_STATUS.CONFIRMED) {
          throw badRequest("버전은 확정으로만 변경할 수 있습니다.");
        }
        const snapshot = context.database.setSnapshotStatus(id, body.status, { actorName: context.user.name });
        context.audit(AUDIT_ACTION.SNAPSHOT_CONFIRMED, "SNAPSHOT", id,
          `${snapshot.projectCode} v${snapshot.versionNo} 확정 · 계약 ${snapshot.contractAmount} · 매입 ${snapshot.totals.purchaseAmount}`);
        sendJson(context.response, 200, snapshot);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/snapshots\/(\d+)\/contract-amount\/refresh$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "버전 ID");
        const snapshot = context.database.refreshSnapshotContractAmount(id);
        context.audit(AUDIT_ACTION.CONTRACT_REFRESHED, "SNAPSHOT", id, `계약금액 갱신: ${snapshot.contractAmount}`);
        sendJson(context.response, 200, snapshot);
      },
    },

    // ------------------------------------------------------------ 입고
    {
      method: "POST",
      pattern: /^\/api\/snapshots\/(\d+)\/receipts\/import$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const snapshotId = positiveInteger(rawId, "버전 ID");
        const body = await readJson(context.request);
        const snapshot = context.database.getSnapshot(snapshotId);
        if (snapshot.status !== SNAPSHOT_STATUS.DRAFT) {
          throw conflict("확정된 버전에는 입고금액을 불러올 수 없습니다. 새 버전을 만들어 주세요.");
        }
        const { receiptMaxRangeDays } = context.database.getSecuritySettings();
        const range = normalizeDateRange({
          fromDate: body.fromDate,
          toDate: body.toDate,
          maxRangeDays: receiptMaxRangeDays,
        });
        const receipts = await context.amarance.fetchReceipts({
          projectCode: snapshot.projectCode,
          fromDate: range.from,
          toDate: range.to,
        });
        const result = context.database.importReceipts(snapshotId, receipts, { replace: Boolean(body.replace) });
        context.audit(AUDIT_ACTION.RECEIPTS_IMPORTED, "SNAPSHOT", snapshotId,
          `${range.from}~${range.to} 반영 ${result.importedCount}건 / 제외 ${result.skippedCount}건${body.replace ? " (기존 삭제 후 재조회)" : ""}`);
        sendJson(context.response, 200, result);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/snapshots\/(\d+)\/receipts$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawId]) {
        const snapshotId = positiveInteger(rawId, "버전 ID");
        const result = context.database.deleteReceipts(snapshotId);
        context.audit(AUDIT_ACTION.RECEIPTS_DELETED, "SNAPSHOT", snapshotId, `입고 전체 삭제 ${result.deletedCount}건`);
        sendJson(context.response, 200, result);
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/snapshots\/(\d+)\/receipts\/(\d+)$/,
      role: USER_ROLE.EDITOR,
      async handle(context, [rawSnapshotId, rawReceiptId]) {
        const snapshotId = positiveInteger(rawSnapshotId, "버전 ID");
        const receiptId = positiveInteger(rawReceiptId, "입고 내역 ID");
        const result = context.database.deleteReceipt(snapshotId, receiptId);
        context.audit(AUDIT_ACTION.RECEIPTS_DELETED, "SNAPSHOT", snapshotId, `입고 1건 삭제 (id ${receiptId})`);
        sendJson(context.response, 200, result);
      },
    },

    // ------------------------------------------------------------ 사용자 관리(관리자)
    {
      method: "GET",
      pattern: /^\/api\/users$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        sendJson(context.response, 200, {
          users: context.database.listUsers(),
          roles: Object.values(USER_ROLE).map((role) => ({ value: role, label: USER_ROLE_LABEL[role] })),
        });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/users$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const body = await readJson(context.request);
        const temporaryPassword = generateReadablePassword(12);
        const created = context.database.createUser({
          loginId: body.loginId,
          name: body.name,
          role: body.role,
          passwordHash: hashPassword(temporaryPassword),
          mustChangePassword: true,
        });
        context.audit(AUDIT_ACTION.USER_CREATED, "USER", created.id, `${created.loginId} (${created.role})`);
        sendJson(context.response, 201, { user: created, temporaryPassword });
      },
    },
    {
      method: "PUT",
      pattern: /^\/api\/users\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "사용자 ID");
        const body = await readJson(context.request);
        if (id === context.user.id && body.role && body.role !== context.user.role) {
          throw forbidden("자신의 권한은 변경할 수 없습니다. 다른 관리자에게 요청해 주세요.");
        }
        const updated = context.database.updateUser(id, body);
        context.audit(AUDIT_ACTION.USER_UPDATED, "USER", id, `${updated.loginId} → ${updated.role}${updated.isActive ? "" : " (중지)"}`);
        sendJson(context.response, 200, updated);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/users\/(\d+)\/password\/reset$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "사용자 ID");
        const target = context.database.getUser(id);
        if (!target) throw notFound("사용자를 찾을 수 없습니다.");
        const temporaryPassword = generateReadablePassword(12);
        context.database.setUserPassword(id, hashPassword(temporaryPassword), { mustChangePassword: true });
        context.auth.logoutAllForUser(id);
        context.audit(AUDIT_ACTION.USER_UPDATED, "USER", id, `${target.loginId} 비밀번호 초기화`);
        sendJson(context.response, 200, { temporaryPassword });
      },
    },
    {
      method: "DELETE",
      pattern: /^\/api\/users\/(\d+)$/,
      role: USER_ROLE.ADMIN,
      async handle(context, [rawId]) {
        const id = positiveInteger(rawId, "사용자 ID");
        if (id === context.user.id) throw forbidden("자신의 계정은 삭제할 수 없습니다.");
        const removed = context.database.deleteUser(id);
        context.audit(AUDIT_ACTION.USER_DELETED, "USER", id, removed.loginId);
        sendNoContent(context.response);
      },
    },
    {
      method: "GET",
      pattern: /^\/api\/audit-logs$/,
      role: USER_ROLE.ADMIN,
      async handle(context) {
        const { searchParams } = context.url;
        sendJson(context.response, 200, context.database.listAuditLogs({
          limit: Number(searchParams.get("limit") || 100),
          offset: Number(searchParams.get("offset") || 0),
          action: String(searchParams.get("action") || "").trim(),
          loginId: String(searchParams.get("loginId") || "").trim(),
        }));
      },
    },

    // ------------------------------------------------------------ 상태 점검
    {
      method: "GET",
      pattern: /^\/api\/health$/,
      role: null,
      async handle(context) {
        sendJson(context.response, 200, {
          status: "ok",
          appName: context.appName,
          version: context.buildInfo.version,
          builtAt: context.buildInfo.builtAt,
          commit: context.buildInfo.commit,
          nodeVersion: process.version,
          mode: context.amarance.getConfiguration().mode,
          time: new Date().toISOString(),
          uptimeSeconds: Math.round(process.uptime()),
        });
      },
    },
  ];
}

export { assertRole };
