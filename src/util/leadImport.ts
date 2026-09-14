export interface ImportedLead {
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  companyWebsite: string;
  role: string;
  country: string;
  contactProfileUrl: string;
  notes: string;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"' && line[i + 1] === '"' && quoted) { current += '"'; i++; }
    else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) { cells.push(current.trim()); current = ''; }
    else current += char;
  }
  cells.push(current.trim());
  return cells;
}

function headerKey(value: string): string {
  return value.replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function value(row: Record<string, string>, ...keys: string[]): string {
  for (const key of keys) if (row[key]) return row[key].trim();
  return '';
}

/** Parse a headered TSV/CSV paste into lead payloads. */
export function parseLeadTable(input: string): ImportedLead[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').filter((line) => line.trim());
  if (lines.length < 2) return [];
  const delimiter = lines[0]?.includes('\t') ? '\t' : ',';
  const headers = splitDelimitedLine(lines[0] ?? '', delimiter).map(headerKey);
  return lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    const phone = value(row, 'phone', 'telephone', 'mobile');
    const fitNote = value(row, 'fit_note', 'fit_notes', 'notes', 'note');
    const notes = [phone ? 'Phone: ' + phone : '', fitNote].filter(Boolean).join('\n');
    const domain = value(row, 'company_domain', 'domain', 'website');
    const linkedin = value(row, 'linkedin', 'linkedin_url', 'contact_profile_url')
      .replace(/^\[.*\]\((https?:\/\/[^)]+)\)$/i, '$1');
    const website = domain && !/^https?:\/\//i.test(domain) ? 'https://' + domain : domain;
    return {
      email: value(row, 'email').toLowerCase(),
      firstName: value(row, 'first_name', 'firstname', 'first'),
      lastName: value(row, 'last_name', 'lastname', 'last'),
      company: value(row, 'company', 'company_name'),
      companyWebsite: website,
      role: value(row, 'position', 'role', 'title', 'job_title'),
      country: value(row, 'location', 'country'),
      contactProfileUrl: linkedin,
      notes,
    };
  }).filter((lead) => lead.email);
}
