// Runs every enabled source in parallel, caches each source's raw results,
// merges duplicates across platforms, then applies the filters that the
// upstream APIs can't do themselves.
import crypto from "node:crypto";
import * as jsearch from "./jsearch.js";
import * as mycareersfuture from "./mycareersfuture.js";
import * as remotive from "./remotive.js";
import * as arbeitnow from "./arbeitnow.js";
import { cacheGet, cacheSet } from "../store.js";
import { uniqueBy } from "../normalize.js";

export const SOURCES = { jsearch, mycareersfuture, remotive, arbeitnow };

// JSearch calls are rationed (free tier), so we hold on to them much longer.
const CACHE_TTL_MS = {
  jsearch: 12 * 60 * 60 * 1000,
  mycareersfuture: 2 * 60 * 60 * 1000,
  remotive: 2 * 60 * 60 * 1000,
  arbeitnow: 2 * 60 * 60 * 1000,
};

export function normalizeParams(input, settings) {
  const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : []);
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    query: String(input.query || "").trim(),
    location: String(input.location || settings.defaultLocation || "Singapore").trim(),
    employmentTypes: arr(input.employmentTypes),
    experienceLevels: arr(input.experienceLevels),
    workArrangement: ["remote", "hybrid", "onsite"].includes(input.workArrangement) ? input.workArrangement : "any",
    datePosted: ["today", "3days", "week", "month"].includes(input.datePosted) ? input.datePosted : "all",
    salaryMin: num(input.salaryMin),
    salaryMax: num(input.salaryMax),
    excludeKeywords: String(input.excludeKeywords || "")
      .split(/[,\n]/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    limit: settings.resultsPerSource || 25,
  };
}

function cacheKeyFor(sourceId, params, settings) {
  // Local-only filters (salaryMax, excludeKeywords) don't change what we ask
  // the API for, so they're left out of the key.
  const sig = {
    s: sourceId,
    q: params.query.toLowerCase(),
    l: params.location.toLowerCase(),
    et: [...params.employmentTypes].sort(),
    el: [...params.experienceLevels].sort(),
    w: params.workArrangement,
    d: params.datePosted,
    sm: params.salaryMin,
    n: params.limit,
    pages: sourceId === "jsearch" ? settings.jsearchPages : undefined,
  };
  return crypto.createHash("sha1").update(JSON.stringify(sig)).digest("hex");
}

export async function runSearch(params, settings, { forceRefresh = false, onlySources = null } = {}) {
  const enabled = Object.values(SOURCES).filter((src) => {
    if (onlySources && !onlySources.includes(src.id)) return false;
    return settings.sources[src.id];
  });

  const results = await Promise.all(
    enabled.map(async (src) => {
      const key = cacheKeyFor(src.id, params, settings);
      if (!forceRefresh) {
        const cached = cacheGet(key, CACHE_TTL_MS[src.id]);
        if (cached) return { ...cached, meta: { ...cached.meta, cached: true } };
      }
      try {
        const out = await src.search(params, settings);
        out.meta = { ...out.meta, source: src.id, label: src.label, fetchedAt: new Date().toISOString() };
        if (!out.meta.error && !out.meta.skipped) cacheSet(key, out);
        return out;
      } catch (err) {
        return { jobs: [], meta: { source: src.id, label: src.label, error: err.name === "TimeoutError" ? `${src.label} timed out` : err.message } };
      }
    }),
  );

  const merged = mergeJobs(results.flatMap((r) => r.jobs));
  const filtered = applyLocalFilters(merged, params);
  return {
    jobs: filtered,
    sources: results.map((r) => ({ ...r.meta, label: r.meta.label || SOURCES[r.meta.source]?.label })),
  };
}

// ---- Cross-platform dedupe ------------------------------------------------

function sourceEntries(job) {
  // Jobs that already went through a merge carry their own sources list.
  return job.sources || [{ source: job.source, sourceLabel: job.sourceLabel, publisher: job.publisher, url: job.url, id: job.id }];
}

export function mergeJobs(jobs) {
  const byKey = new Map();
  for (const job of jobs) {
    const existing = byKey.get(job.key);
    if (!existing) {
      byKey.set(job.key, { ...job, sources: sourceEntries(job) });
      continue;
    }
    // Keep the richest description as the primary record.
    const primary = (job.description || "").length > (existing.description || "").length ? job : existing;
    const secondary = primary === job ? existing : job;
    const mergedJob = {
      ...primary,
      id: existing.id,
      key: existing.key,
      sources: uniqueBy([...existing.sources, ...sourceEntries(job)], (s) => s.id || s.url),
      applyOptions: uniqueBy([...(existing.applyOptions || []), ...(job.applyOptions || [])], (o) => o.url),
      salary: primary.salary || secondary.salary || null,
      companyLogo: primary.companyLogo || secondary.companyLogo || null,
      postedAt: latest(primary.postedAt, secondary.postedAt),
      remote: primary.remote ?? secondary.remote ?? null,
      employmentType: primary.employmentType || secondary.employmentType || null,
      experienceLevel: primary.experienceLevel || secondary.experienceLevel || null,
      minYearsExperience: primary.minYearsExperience ?? secondary.minYearsExperience ?? null,
      skills: [...new Set([...(primary.skills || []), ...(secondary.skills || [])])],
      extra: { ...(secondary.extra || {}), ...(primary.extra || {}) },
    };
    byKey.set(job.key, mergedJob);
  }
  return [...byKey.values()];
}

function latest(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return new Date(a) > new Date(b) ? a : b;
}

// ---- Filters the APIs can't apply for us ---------------------------------

const HOURS_PER_MONTH = 160;

export function monthlyEquivalent(salary) {
  if (!salary) return null;
  const v = salary.max || salary.min;
  if (!v) return null;
  switch (salary.period) {
    case "year": case "yearly": case "annual": case "annually": return v / 12;
    case "hour": case "hourly": return v * HOURS_PER_MONTH;
    case "day": case "daily": return v * 21;
    case "week": case "weekly": return v * 4.33;
    default: return v; // month / unknown
  }
}

export function applyLocalFilters(jobs, params) {
  const excl = params.excludeKeywords;
  return jobs.filter((job) => {
    if (excl.length) {
      const hay = `${job.title} ${job.company} ${job.description}`.toLowerCase();
      if (excl.some((k) => hay.includes(k))) return false;
    }
    if (params.employmentTypes.length && job.employmentType && !params.employmentTypes.includes(job.employmentType)) return false;
    if (params.experienceLevels.length && job.experienceLevel && !params.experienceLevels.includes(job.experienceLevel)) return false;

    const text = `${job.title} ${job.description}`.toLowerCase();
    if (params.workArrangement === "remote" && job.remote !== true && !/\bremote\b|work from home|wfh/.test(text)) return false;
    if (params.workArrangement === "hybrid" && !/\bhybrid\b/.test(text)) return false;
    if (params.workArrangement === "onsite" && job.remote === true) return false;

    // Salary: only compare when we can express the figure per month in a
    // comparable currency; jobs without a salary are kept and flagged.
    if ((params.salaryMin || params.salaryMax) && job.salary && (!job.salary.currency || job.salary.currency === "SGD")) {
      const monthly = monthlyEquivalent(job.salary);
      const monthlyMin = job.salary.min ? monthlyEquivalent({ ...job.salary, max: null }) : monthly;
      if (monthly != null) {
        if (params.salaryMin && monthly < params.salaryMin) return false;
        if (params.salaryMax && monthlyMin > params.salaryMax) return false;
      }
    }
    return true;
  }).map((job) => ({ ...job, salaryUnknown: !job.salary }));
}
