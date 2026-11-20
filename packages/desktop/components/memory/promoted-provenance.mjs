// A derived memory is eligible only while its current source is still valid.
// This is a read filter, not a destructive migration of the original archive.
export function currentPromotion(store, scope, row) {
  const source = row.source;
  if (source?.type !== 'distill-promoted') return true;
  if (!Array.isArray(source.observations) || !source.observations.length
    || typeof source.subject !== 'string' || typeof source.predicate !== 'string'
    || typeof source.value !== 'string') return false;
  const latest = store.db.prepare(`SELECT o.id,o.value FROM yunshu_observations o
    JOIN yunshu_sources s ON s.id=o.source_id AND s.scope=o.scope
    WHERE o.scope=? AND o.subject=? AND o.predicate=? AND o.state='confirmed'
      AND o.kind IN ('fact','experience','observation') AND s.withdrawn=0
    ORDER BY o.created_at DESC,o.rowid DESC LIMIT 1`).get(scope, source.subject, source.predicate);
  if (!latest || !source.observations.includes(latest.id)) return false;
  try {
    // Match the promoter's normalization; formatting must not invalidate evidence.
    const value = JSON.parse(latest.value);
    return typeof value === 'string' && value.replace(/\s+/g, ' ').trim() === source.value;
  } catch { return false; }
}
