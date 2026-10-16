/** Audit trail for 1.0: one structured log line per event. Never pass tokens, links or passwords. */
export function audit(event: string, fields: Record<string, unknown> = {}) {
  console.info(JSON.stringify({ event, ...fields, at: new Date().toISOString() }));
}
