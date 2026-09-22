// Arbeitnow — free job-board API, mostly European listings. Off by default;
// when enabled we only keep remote roles and match the query locally because
// the API has no search parameter.
import { stripHtml, jobKey, mapEmploymentType, inferExperienceLevel, toIso } from "../normalize.js";

export const id = "arbeitnow";
export const label = "Arbeitnow (remote)";
export const needsKey = null;

export async function search(params) {
  if (params.workArrangement === "onsite") {
    return { jobs: [], meta: { source: id, skipped: "Remote-only board skipped for onsite search" } };
  }
  const res = await fetch("https://www.arbeitnow.com/api/job-board-api?page=1", {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return { jobs: [], meta: { source: id, error: `Arbeitnow HTTP ${res.status}` } };
  const data = await res.json();

  const terms = String(params.query || "").toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const jobs = (data.data || [])
    .filter((j) => j.remote === true || j.remote === "true")
    .filter((j) => {
      const hay = `${j.title} ${(j.tags || []).join(" ")}`.toLowerCase();
      return terms.length === 0 || terms.every((t) => hay.includes(t));
    })
    .slice(0, Number(params.limit) || 25)
    .map(normalizeJob)
    .filter(Boolean);
  return { jobs, meta: { source: id, count: jobs.length } };
}

function normalizeJob(j) {
  if (!j || !j.title) return null;
  return {
    id: `arbeitnow:${j.slug}`,
    key: jobKey(j.title, j.company_name),
    source: id,
    sourceLabel: label,
    publisher: "Arbeitnow",
    title: j.title.trim(),
    company: (j.company_name || "Unknown company").trim(),
    companyLogo: null,
    location: j.location ? `Remote · ${j.location}` : "Remote",
    country: null,
    remote: true,
    employmentType: mapEmploymentType((j.job_types || [])[0]),
    experienceLevel: inferExperienceLevel(j.title, null),
    minYearsExperience: null,
    salary: null,
    postedAt: toIso(j.created_at),
    url: j.url,
    applyOptions: [{ publisher: "Arbeitnow", url: j.url }],
    description: stripHtml(stripHtml(j.description)), // API double-encodes HTML entities
    highlights: { qualifications: [], responsibilities: [], benefits: [] },
    skills: Array.isArray(j.tags) ? j.tags : [],
  };
}
