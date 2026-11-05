import { AUDIT_ACTION } from "./constants.mjs";

/** 자동 동기화가 활동 기록에 남길 이름. */
const SYSTEM_ACTOR = Object.freeze({ id: null, loginId: "system", name: "자동 동기화" });
/** 예약 시각이 됐는지 확인하는 간격. */
const CHECK_INTERVAL_MS = 60_000;
/** 자동 동기화가 실패하면 아마란스10 을 계속 두드리지 않도록 이만큼 쉬었다가 다시 시도합니다. */
const RETRY_AFTER_FAILURE_MS = 30 * 60_000;

export const PROJECT_SYNC_MODE = Object.freeze({ DAILY: "daily", INTERVAL: "interval" });

/** 매일 HH:MM 의 오늘 시각(서버 시간대). */
function todayAt(time, now) {
  const [hours, minutes] = String(time).split(":").map(Number);
  const target = new Date(now);
  target.setHours(hours, minutes, 0, 0);
  return target;
}

/**
 * 다음 자동 동기화 예정 시각. 꺼져 있으면 null.
 * 기준은 마지막으로 '성공한' 동기화(수동 포함)입니다. 방금 손으로 동기화했으면 자동은 그만큼 미룹니다.
 * - 매일: 오늘 그 시각이 지났고 그 뒤로 동기화한 적이 없으면 '지금', 있으면 내일 그 시각
 * - N시간마다: 마지막 성공 + N시간(한 번도 안 했으면 '지금')
 * 자동 동기화가 방금 실패했으면 RETRY_AFTER_FAILURE_MS 뒤로 미룹니다.
 */
export function nextProjectSync(schedule, status = {}, now = new Date()) {
  if (!schedule?.enabled) return null;
  const last = status.lastOkAt ? new Date(status.lastOkAt) : null;
  let next;
  if (schedule.mode === PROJECT_SYNC_MODE.INTERVAL) {
    next = last ? new Date(last.getTime() + schedule.intervalHours * 3_600_000) : now;
  } else {
    const target = todayAt(schedule.time, now);
    if (now < target) next = target;
    else if (!last || last < target) next = now;
    else {
      next = new Date(target);
      next.setDate(next.getDate() + 1);
    }
  }
  const attempt = status.lastAutoAttempt;
  if (attempt && !attempt.ok) {
    const retry = new Date(new Date(attempt.at).getTime() + RETRY_AFTER_FAILURE_MS);
    if (retry > next) next = retry;
  }
  return next < now ? now : next;
}

/** 아마란스10 프로젝트를 가져와 목록에 반영하고, 결과를 활동 기록과 동기화 상태에 남깁니다. */
export async function syncProjects({ database, amarance, logger, trigger = "manual", actor = null, ip = "" }) {
  const startedAt = new Date().toISOString();
  try {
    const fetched = await amarance.searchProjects();
    const { projects, summary } = database.upsertProjects(fetched, { reconcile: true });
    const detail = `수신 ${summary.received} · 추가 ${summary.created} · 갱신 ${summary.updated} · 보관 ${summary.archived} · 삭제 ${summary.removed}`;
    database.recordProjectSync({ at: startedAt, trigger, ok: true, summary });
    database.recordAudit({
      actor: actor || SYSTEM_ACTOR,
      action: AUDIT_ACTION.PROJECT_SYNCED,
      targetType: "PROJECT",
      detail: trigger === "auto" ? `[자동] ${detail}` : detail,
      ip,
    });
    if (summary.received === 0) {
      logger?.warn("아마란스10 프로젝트 조회 결과가 0건입니다.", {
        mode: amarance.getConfiguration().mode,
        companyCode: amarance.getConfiguration().companyCode,
      });
    }
    return { projects, summary };
  } catch (error) {
    database.recordProjectSync({ at: startedAt, trigger, ok: false, error: error.message || "동기화에 실패했습니다." });
    throw error;
  }
}

/** 예약된 시각마다 프로젝트를 동기화합니다. 서버 한 대 안에서 동시에 두 번 돌지 않습니다. */
export function createProjectSyncScheduler({ database, amarance, logger, checkIntervalMs = CHECK_INTERVAL_MS }) {
  let timer = null;
  let running = false;

  async function runIfDue(now = new Date()) {
    if (running) return false;
    const schedule = database.getProjectSyncSchedule();
    const next = nextProjectSync(schedule, database.getProjectSyncStatus(), now);
    if (!next || next > now) return false;
    running = true;
    try {
      const { summary } = await syncProjects({ database, amarance, logger, trigger: "auto" });
      logger?.info("프로젝트를 자동으로 동기화했습니다.", summary);
      return true;
    } catch (error) {
      logger?.error("프로젝트 자동 동기화에 실패했습니다.", { error });
      return false;
    } finally {
      running = false;
    }
  }

  return {
    runIfDue,
    start() {
      if (timer) return;
      timer = setInterval(() => { runIfDue().catch(() => {}); }, checkIntervalMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
