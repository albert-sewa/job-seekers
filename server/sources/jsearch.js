// JSearch (RapidAPI) — aggregates Google for Jobs, which carries listings from
// LinkedIn, Indeed, JobStreet, MyCareersFuture, Glassdoor and company sites.
// Docs: https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch
//
// Free tier is ~200 requests/month, and every page is one request, so this
// adapter is deliberately frugal: one page per search unless the user raises
// `jsearchPages` in Settings.
import {
  stripHtml, jobKey, mapEmploymentType, inferExperienceLevel, toIso,
} from "../normalize.js";

export const id = "jsearch";
export const label = "JSearch (Google Jobs)";
export const needsKey = "rapidApiKey";

const HOST = "jsearch.p.rapidapi.com";

const EMPLOYMENT_MAP = {
  "Full-time": "FULLTIME",
  "Contract": "CONTRACTOR",
  "Part-time": "PARTTIME",
  "Internship": "INTERN",
};

const DATE_MAP = { all: "all", today: "today", "3days": "3days", week: "week", month: "month" };

// Location → JSearch country code. Anything else falls back to putting the
// location in the query string, which JSearch also understands.
const COUNTRY_CODES = {
  singapore: "sg", malaysia: "my", indonesia: "id", thailand: "th", vietnam: "vn",
  philippines: "ph", "hong kong": "hk", australia: "au", "united kingdom": "gb", uk: "gb",
  "united states": "us", usa: "us", india: "in", japan: "jp", taiwan: "tw", china: "cn",
};

export function countryCode(location) {
  const l = String(location || "").toLowerCase().trim();
  for (const [name, code] of Object.entries(COUNTRY_CODES)) {
    if (l === name || l.endsWith(", " + name) || l.includes(name)) return code;
  }
  return null;
}

export async function search(params, settings) {
  const key = settings.rapidApiKey;
  if (!key) return { jobs: [], meta: { source: id, skipped: "No RapidAPI key in Settings" } };

  const location = params.location || settings.defaultLocation || "Singapore";
  const q = new URLSearchParams();
  q.set("query", `${params.query} in ${location}`);
  q.set("num_pages", "1");
  q.set("date_posted", DATE_MAP[params.datePosted] || "all");
  const cc = countryCode(location);
  if (cc) q.set("country", cc);

  const types = (params.employmentTypes || []).map((t) => EMPLOYMENT_MAP[t]).filter(Boolean);
  if (types.length) q.set("employment_types", types.join(","));

  if (params.workArrangement === "remote") q.set("work_from_home", "true");

  const reqs = [];
  if ((params.experienceLevels || []).includes("Entry")) reqs.push("under_3_years_experience", "no_experience");
  if ((params.experienceLevels || []).some((l) => l === "Senior" || l === "Executive")) reqs.push("more_than_3_years_experience");
  if (reqs.length && !(params.experienceLevels || []).includes("Mid")) q.set("job_requirements", reqs.join(","));

  // v2 of the endpoint pages with a cursor; every page is one API request.
  const pages = Math.min(3, Math.max(1, Number(settings.jsearchPages) || 1));
  const jobs = [];
  let quota = { limit: null, remaining: null };
  let cursor = null;
  for (let page = 0; page < pages; page++) {
    if (page > 0 && !cursor) break;
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`https://${HOST}/search-v2?${q}`, {
      headers: { "x-rapidapi-key": key, "x-rapidapi-host": HOST },
      signal: AbortSignal.timeout(50_000), // JSearch routinely takes 10-20s
    });

    quota = {
      limit: Number(res.headers.get("x-ratelimit-requests-limit")) || quota.limit,
      remaining: Number(res.headers.get("x-ratelimit-requests-remaining")) || quota.remaining,
    };

    if (res.status === 429) {
      return { jobs, meta: { source: id, quota, error: "JSearch monthly quota exhausted (429)." } };
    }
    if (res.status === 401 || res.status === 403) {
      return { jobs, meta: { source: id, quota, error: "RapidAPI key rejected. Check it in Settings and make sure you subscribed to the JSearch free plan." } };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { jobs, meta: { source: id, quota, error: `JSearch HTTP ${res.status}: ${text.slice(0, 200)}` } };
    }

    const body = await res.json();
    // Older versions returned data as an array; v2 nests it as { jobs, cursor }.
    const list = Array.isArray(body.data) ? body.data : body.data?.jobs || [];
    jobs.push(...list.map(normalizeJob).filter(Boolean));
    cursor = Array.isArray(body.data) ? null : body.data?.cursor || null;
    if (!list.length) break;
  }
  return { jobs, meta: { source: id, count: jobs.length, quota } };
}

function normalizeJob(j) {
  if (!j || !j.job_title) return null;
  const typeRaw = Array.isArray(j.job_employment_types) ? j.job_employment_types[0] : j.job_employment_type;
  const salaryMin = numOrNull(j.job_min_salary);
  const salaryMax = numOrNull(j.job_max_salary);
  const locationParts = [j.job_city, j.job_state, j.job_country].filter(Boolean);
  const description = stripHtml(j.job_description);
  const hl = j.job_highlights || {};

  const applyOptions = (j.apply_options || [])
    .filter((o) => o && o.apply_link)
    .map((o) => ({ publisher: o.publisher || "Apply", url: o.apply_link }));
  if (!applyOptions.length && j.job_apply_link) {
    applyOptions.push({ publisher: j.job_publisher || "Apply", url: j.job_apply_link });
  }

  return {
    id: `jsearch:${j.job_id}`,
    key: jobKey(j.job_title, j.employer_name),
    source: id,
    sourceLabel: label,
    publisher: j.job_publisher || null,
    title: j.job_title.trim(),
    company: (j.employer_name || "Unknown company").trim(),
    companyLogo: j.employer_logo || null,
    location: j.job_location || locationParts.join(", ") || null,
    country: j.job_country || null,
    remote: typeof j.job_is_remote === "boolean" ? j.job_is_remote : null,
    employmentType: mapEmploymentType(typeRaw),
    experienceLevel: inferExperienceLevel(j.job_title, null),
    minYearsExperience: null,
    salary: salaryMin || salaryMax
      ? { min: salaryMin, max: salaryMax, currency: guessCurrency(j), period: (j.job_salary_period || "").toLowerCase() || null }
      : null,
    postedAt: toIso(j.job_posted_at_datetime_utc) || toIso(j.job_posted_at_timestamp),
    url: j.job_apply_link || (applyOptions[0] && applyOptions[0].url) || j.job_google_link || null,
    applyOptions,
    description,
    highlights: {
      qualifications: hl.Qualifications || [],
      responsibilities: hl.Responsibilities || [],
      benefits: hl.Benefits || [],
    },
    skills: [],
  };
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function guessCurrency(j) {
  if (j.job_salary_currency) return j.job_salary_currency;
  const c = String(j.job_country || "").toUpperCase();
  return { SG: "SGD", MY: "MYR", ID: "IDR", TH: "THB", VN: "VND", PH: "PHP", HK: "HKD", AU: "AUD", GB: "GBP", US: "USD", IN: "INR" }[c] || null;
}
