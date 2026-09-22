// Helpers shared by every source adapter so all jobs end up in one shape:
//
// {
//   id, key, source, sourceLabel, publisher,
//   title, company, companyLogo,
//   location, country, remote,
//   employmentType,        // Full-time | Contract | Part-time | Internship | Temporary | null
//   experienceLevel,       // Entry | Mid | Senior | Executive | null
//   minYearsExperience,    // number | null
//   salary: { min, max, currency, period } | null,
//   postedAt,              // ISO string | null
//   url, applyOptions: [{ publisher, url }],
//   description,           // plain text
//   highlights: { qualifications: [], responsibilities: [], benefits: [] },
//   skills: []
// }

export function stripHtml(html) {
  if (!html) return "";
  return String(html)
    .replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const COMPANY_NOISE = /\b(pte\.?|ltd\.?|limited|inc\.?|llc|llp|plc|co\.?|corp\.?|corporation|company|group|holdings|singapore|sg|asia|pacific|international|the)\b/g;

export function normalizeCompany(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(COMPANY_NOISE, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")
    .replace(/\b(urgent|hiring|immediate|new|remote|hybrid|wfh|contract|perm|permanent|full[- ]?time|part[- ]?time)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

// Two postings with the same normalized title + company are treated as the
// same job even if they came from different platforms.
export function jobKey(title, company) {
  const t = normalizeTitle(title);
  const c = normalizeCompany(company) || "unknown";
  return `${t}|${c}`;
}

export function mapEmploymentType(raw) {
  if (!raw) return null;
  const s = String(raw).toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("intern")) return "Internship";
  if (s.includes("parttime")) return "Part-time";
  if (s.includes("contract") || s.includes("contractor") || s.includes("freelance")) return "Contract";
  if (s.includes("temp")) return "Temporary";
  if (s.includes("fulltime") || s.includes("permanent")) return "Full-time";
  return null;
}

// Best-effort seniority from the title when the source doesn't say.
export function inferExperienceLevel(title, minYears) {
  const t = String(title || "").toLowerCase();
  if (/\b(intern|internship|trainee|graduate|fresh|junior|entry|associate)\b/.test(t)) return "Entry";
  if (/\b(chief|cxo|ceo|cto|cfo|coo|vp|vice president|head of|director|managing)\b/.test(t)) return "Executive";
  if (/\b(senior|sr\.?|lead|principal|staff|manager|specialist ii|iii)\b/.test(t)) return "Senior";
  if (minYears != null) {
    if (minYears <= 1) return "Entry";
    if (minYears >= 6) return "Senior";
    return "Mid";
  }
  return null;
}

export function toIso(value) {
  if (!value) return null;
  const d = typeof value === "number" ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function clampText(text, max) {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + " …" : text;
}

export function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}
