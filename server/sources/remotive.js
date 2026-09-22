// Remotive — public API for remote jobs worldwide. No key required.
// https://remotive.com/api/remote-jobs?search=...&limit=...
// Only relevant when the searcher is open to remote work, so we keep the
// results to ones that don't exclude Asia/Singapore by location.
import { stripHtml, jobKey, mapEmploymentType, inferExperienceLevel, toIso } from "../normalize.js";

export const id = "remotive";
export const label = "Remotive (remote)";
export const needsKey = null;

export async function search(params) {
  if (params.workArrangement === "onsite") {
    return { jobs: [], meta: { source: id, skipped: "Remote-only board skipped for onsite search" } };
  }
  const q = new URLSearchParams({ search: params.query, limit: String(Math.min(Number(params.limit) || 25, 50)) });
  const res = await fetch(`https://remotive.com/api/remote-jobs?${q}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { jobs: [], meta: { source: id, error: `Remotive HTTP ${res.status}` } };
  const data = await res.json();

  const location = String(params.location || "").toLowerCase();
  let jobs = (data.jobs || []).map(normalizeJob).filter(Boolean);
  // Remotive's search matches loosely (any word, anywhere), so re-check
  // relevance locally: every query term in title/tags, or the exact phrase
  // somewhere in the description.
  jobs = jobs.filter((j) => isRelevant(j, params.query));
  // Drop jobs whose required location clearly excludes the searcher.
  jobs = jobs.filter((j) => locationCompatible(j.location, location));
  return { jobs, meta: { source: id, count: jobs.length } };
}

function isRelevant(job, query) {
  const phrase = String(query || "").toLowerCase().trim();
  const terms = phrase.split(/\s+/).filter((t) => t.length > 2);
  if (!terms.length) return true;
  const head = `${job.title} ${(job.skills || []).join(" ")} ${job.extra?.category || ""}`.toLowerCase();
  if (terms.every((t) => head.includes(t))) return true;
  return job.description.toLowerCase().includes(phrase);
}

function locationCompatible(required, searcherLocation) {
  const r = String(required || "").toLowerCase();
  if (!r || r === "worldwide" || r === "anywhere") return true;
  const openTerms = ["worldwide", "anywhere", "global", "apac", "asia", "singapore", "sea", "remote"];
  if (openTerms.some((t) => r.includes(t))) return true;
  if (searcherLocation && r.includes(searcherLocation.split(",")[0].trim())) return true;
  // Region lists like "USA, Canada" are not compatible with a Singapore searcher.
  return false;
}

function normalizeJob(j) {
  if (!j || !j.title) return null;
  const salary = parseSalaryText(j.salary);
  return {
    id: `remotive:${j.id}`,
    key: jobKey(j.title, j.company_name),
    source: id,
    sourceLabel: label,
    publisher: "Remotive",
    title: j.title.trim(),
    company: (j.company_name || "Unknown company").trim(),
    companyLogo: j.company_logo || null,
    location: j.candidate_required_location || "Worldwide",
    country: null,
    remote: true,
    employmentType: mapEmploymentType(j.job_type),
    experienceLevel: inferExperienceLevel(j.title, null),
    minYearsExperience: null,
    salary,
    postedAt: toIso(j.publication_date),
    url: j.url,
    applyOptions: [{ publisher: "Remotive", url: j.url }],
    description: stripHtml(j.description),
    highlights: { qualifications: [], responsibilities: [], benefits: [] },
    skills: Array.isArray(j.tags) ? j.tags : [],
    extra: { category: j.category || null },
  };
}

// Remotive salaries are free text like "$90k - $105k" or "€60,000/year".
function parseSalaryText(text) {
  if (!text) return null;
  const s = String(text);
  const currency = s.includes("€") ? "EUR" : s.includes("£") ? "GBP" : s.includes("S$") ? "SGD" : s.includes("$") ? "USD" : null;
  const nums = [...s.matchAll(/(\d[\d,.]*)\s*(k)?/gi)].map((m) => {
    // "31,200" is a thousands separator; "31,2k" is a decimal comma.
    const cleaned = m[1].replace(/,(\d{3})(?!\d)/g, "$1").replace(",", ".");
    const n = parseFloat(cleaned);
    return m[2] ? n * 1000 : n;
  }).filter((n) => Number.isFinite(n) && n >= 100);
  if (!nums.length) return null;
  const period = /hour|hr/i.test(s) ? "hour" : /month|mo\b/i.test(s) ? "month" : "year";
  return { min: Math.round(Math.min(...nums)), max: nums.length > 1 ? Math.round(Math.max(...nums)) : null, currency, period, raw: s };
}
