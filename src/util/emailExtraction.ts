const EMAIL_PATTERN = /[A-Z0-9](?:[A-Z0-9._%+-]*[A-Z0-9])?@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,}/gi;

/** Extract unique, syntactically valid email addresses from pasted mixed text. */
export function extractEmailAddresses(input: string): string[] {
  const matches = input.match(EMAIL_PATTERN) ?? [];
  return [...new Set(matches.map((email) => email.toLowerCase()))];
}
