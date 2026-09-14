/** Audit-trail helper. `detail` must contain ids and codes only - never bodies or PII. */
export function recordEventStmt(
  db: D1Database,
  leadId: string,
  event: string,
  detail?: Record<string, unknown>
): D1PreparedStatement {
  return db
    .prepare('INSERT INTO lead_events (lead_id, event, detail) VALUES (?1, ?2, ?3)')
    .bind(leadId, event, detail ? JSON.stringify(detail) : null);
}

export async function recordEvent(
  db: D1Database,
  leadId: string,
  event: string,
  detail?: Record<string, unknown>
): Promise<void> {
  await recordEventStmt(db, leadId, event, detail).run();
}

export function inPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',');
}
