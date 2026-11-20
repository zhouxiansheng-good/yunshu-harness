export const HEALTH_CHECKS = {
  memory: { label: '记忆', nextAction: '打开记忆，验证跨会话召回与更正' },
  persona: { label: '人格', nextAction: '打开人格，验证档案保存与情绪线索' },
  media: { label: '媒体', nextAction: '打开媒体，检查附件保存与读取' },
  task: { label: '任务台', nextAction: '核对原派单与回执再继续' },
  voice: { label: '语音', nextAction: '打开语音，试听并检查麦克风设备' },
  deep: { label: '深度模式', nextAction: '核对切换前后的实际能力', visibleInDock: false },
};
export const HEALTH_TTL_MS = 300_000;
export const CHECK_IDS = Object.keys(HEALTH_CHECKS);
export const NEXT_ACTION = Object.fromEntries(Object.entries(HEALTH_CHECKS).map(([id, entry]) => [id, entry.nextAction]));
const STATES = new Set(['ok', 'warn', 'late', 'unknown', 'idle']);
export function countHealth(checks) {
  const counts = Object.fromEntries([...STATES].map(state => [state, 0]));
  for (const row of checks) counts[STATES.has(row.state) ? row.state : 'unknown']++;
  return counts;
}
export function healthRows(snapshot, expectedProfileId, now = Date.now()) {
  let invalid = null;
  if (!snapshot) invalid = '尚无健康快照';
  else if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.checks) ||
    typeof snapshot.profileId !== 'string' || !snapshot.profileId) invalid = '健康快照格式无效';
  else if (!expectedProfileId || snapshot.profileId !== expectedProfileId) invalid = '健康快照与当前 profile 不符';
  const checks = invalid ? [] : snapshot.checks;
  return CHECK_IDS.map(id => {
    const matches = checks.filter(row => row?.id === id);
    const row = matches[0];
    let reason = invalid || (matches.length !== 1 ? '本项尚无唯一健康结果' : null);
    let state = 'unknown';
    if (!reason) {
      const at = Date.parse(row.checkedAt), ttl = Number(row.staleAfterMs);
      if (!STATES.has(row.state) || typeof row.reason !== 'string' || !Number.isFinite(at) ||
          !Number.isFinite(ttl) || ttl <= 0 || at > now + 5000) reason = '健康结果格式或时间无效';
      else if (now - at > ttl) { state = 'late'; reason = '健康结果已过期；' + row.reason; }
      else { state = row.state; reason = row.reason; }
    }
    const disabled = state === 'idle' && row?.facets?.availability === 'disabled';
    return { id, label: HEALTH_CHECKS[id].label, visibleInDock: HEALTH_CHECKS[id].visibleInDock !== false,
      state, reason, checkedAt: row?.checkedAt ?? null,
      staleAfterMs: row?.staleAfterMs ?? null, facets: invalid ? {} : row?.facets ?? {},
      evidence: invalid ? '' : row?.evidence ?? '',
      nextAction: disabled ? '需要保存附件时，可在当前配置启用媒体功能' : NEXT_ACTION[id] };
  });
}
