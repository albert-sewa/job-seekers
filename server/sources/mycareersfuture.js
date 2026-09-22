// MyCareersFuture — Singapore's government job portal. The portal's own
// frontend talks to api.mycareersfuture.gov.sg; there is no official public
// API, so this adapter mirrors those calls and may need updating if they change.
// Search results omit the description, so we fetch each job's detail page
// (a few at a time) to get the full text for AI scoring.
import {
  stripHtml, jobKey, mapEmploymentType, inferExperienceLevel, toIso,
} from "../normalize.js";

export const id = "mycareersfuture";
export const label = "MyCareersFuture";
export const needsKey = null;

const API = "https://api.mycareersfuture.gov.sg/v2";
const DETAIL_CONCURRENCY = 6;

const EMPLOYMENT_MAP = {
  "Full-time": ["Full Time", "Permanent"],
  "Contract": ["Contract", "Freelance"],
  "Part-time": ["Part Time", "Flexi-work"],
  "Internship": ["Internship/Attachment"],
  "Temporary": ["Temporary"],
};

const LEVEL_MAP = {
  Entry: ["Fresh/entry level", "Junior Executive", "Non-executive"],
  Mid: ["Executive", "Senior Executive", "Professional"],
  Senior: ["Manager", "Middle Management"],
  Executive: ["Senior Management"],
};

const LEVEL_FROM_MCF = {
  "Fresh/entry level": "Entry", "Junior Executive": "Entry", "Non-executive": "Entry",
  "Executive": "Mid", "Senior Executive": "Mid", "Professional": "Mid",
  "Manager": "Senior", "Middle Management": "Senior",
  "Senior Management": "Executive",
};

export async function search(params, settings) {
  const location = String(params.location || settings.defaultLocation || "Singapore").toLowerCase();
  if (location && !location.includes("singapore") && !location.includes("remote")) {
    return { jobs: [], meta: { source: id, skipped: "MyCareersFuture only lists Singapore jobs" } };
  }

  // Omitting sortBy gives relevance ordering; "new_posting_date" is the only
  // other value the API accepts.
  const body = { search: params.query };
  const types = (params.employmentTypes || []).flatMap((t) => EMPLOYMENT_MAP[t] || []);
  if (types.length) body.employmentTypes = types;
  const levels = (params.experienceLevels || []).flatMap((l) => LEVEL_MAP[l] || []);
  if (levels.length) body.positionLevels = levels;
  if (params.salaryMin) body.salary = Number(params.salaryMin);
  if (params.datePosted && params.datePosted !== "all") {
    body.sortBy = ["new_posting_date"];
  }

  const limit = Math.min(Number(params.limit) || 25, 50);
  const res = await fetch(`${API}/search?limit=${limit}&page=0`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    return { jobs: [], meta: { source: id, error: `MyCareersFuture HTTP ${res.status}` } };
  }
  const data = await res.json();
  let results = data.results || [];

  // Client-side freshness filter — the API has no date parameter.
  const cutoff = dateCutoff(params.datePosted);
  if (cutoff) {
    results = results.filter((r) => {
      const d = new Date(r.metadata?.newPostingDate || r.metadata?.updatedAt || 0);
      return d >= cutoff;
    });
  }

  const details = await mapWithConcurrency(results, DETAIL_CONCURRENCY, fetchDetail);
  const jobs = results.map((r, i) => normalizeJob(r, details[i])).filter(Boolean);
  return { jobs, meta: { source: id, count: jobs.length, total: data.total } };
}

async function fetchDetail(r) {
  try {
    const res = await fetch(`${API}/jobs/${r.uuid}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function normalizeJob(r, detail) {
  if (!r || !r.title) return null;
  const d = detail || {};
  const company = r.postedCompany?.name || r.hiringCompany?.name || "Undisclosed employer";
  const salary = r.salary && (r.salary.minimum || r.salary.maximum)
    ? {
        min: r.salary.minimum || null,
        max: r.salary.maximum || null,
        currency: "SGD",
        period: String(r.salary.type?.salaryType || "Monthly").toLowerCase(),
      }
    : null;
  const levelRaw = r.positionLevels?.[0]?.position;
  const minYears = Number.isFinite(d.minimumYearsExperience) ? d.minimumYearsExperience : null;
  const flex = (r.flexibleWorkArrangements || []).map((f) => String(f.flexibleWorkArrangement || f).toLowerCase()).join(" ");
  const url = r.metadata?.jobDetailsUrl || `https://www.mycareersfuture.gov.sg/job/${r.uuid}`;
  const districts = (r.address?.districts || []).map((x) => x.location).filter(Boolean);

  return {
    id: `mcf:${r.uuid}`,
    key: jobKey(r.title, company),
    source: id,
    sourceLabel: label,
    publisher: "MyCareersFuture",
    title: r.title.trim(),
    company: company.trim(),
    companyLogo: r.postedCompany?.logoUploadPath || null,
    location: r.address?.isOverseas ? (r.address.overseasCountry || "Overseas") : (districts[0] ? `Singapore · ${districts[0]}` : "Singapore"),
    country: r.address?.isOverseas ? null : "Singapore",
    remote: flex.includes("remote") || flex.includes("work from home") ? true : null,
    employmentType: mapEmploymentType(r.employmentTypes?.[0]?.employmentType),
    // A "Senior"/"Lead"/"Head of" in the title beats MCF's broad position bands.
    experienceLevel: inferExperienceLevel(r.title, null) || LEVEL_FROM_MCF[levelRaw] || inferExperienceLevel(r.title, minYears),
    minYearsExperience: minYears,
    salary,
    postedAt: toIso(r.metadata?.newPostingDate || r.metadata?.updatedAt),
    url,
    applyOptions: [{ publisher: "MyCareersFuture", url }],
    description: stripHtml(d.description) || "",
    highlights: {
      qualifications: d.otherRequirements ? [stripHtml(d.otherRequirements)] : [],
      responsibilities: [],
      benefits: [],
    },
    skills: (r.skills || []).map((s) => s.skill).filter(Boolean),
    extra: {
      positionLevel: levelRaw || null,
      category: (r.categories || []).map((c) => c.category).join(", ") || null,
      applicants: r.metadata?.totalNumberJobApplication ?? null,
      vacancies: d.numberOfVacancies ?? null,
    },
  };
}

function dateCutoff(datePosted) {
  const days = { today: 1, "3days": 3, week: 7, month: 30 }[datePosted];
  if (!days) return null;
  return new Date(Date.now() - days * 86_400_000);
}

async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
