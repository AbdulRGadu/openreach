/** D1 exec treats each newline as a separate query, so keep every statement on one line. */
export function formatD1ExecScript(script: string): string {
  return script
    .replace(/--[^\n\r]*/g, '')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .map((statement) => `${statement};`)
    .join('\n');
}
