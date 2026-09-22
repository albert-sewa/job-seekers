// Job Seek — stateless API. The same app runs locally (server/index.js) and on
// Vercel (api/index.js). It keeps no user data: keys, CV profile, tracker and
// scores are stored in the browser and sent with each request as needed.
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheClear } from "./store.js";
import { runSearch, normalizeParams, mergeJobs, SOURCES } from "./sources/index.js";
import { buildDeepLinks } from "./deeplinks.js";
import { extractProfile, scoreJobs, analyzeJob, friendlyAiError } from "./ai.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(here, "..", "public");

const DEFAULT_SOURCES = { jsearch: true, mycareersfuture: true, remotive: true, arbeitnow: false };
const MODELS = ["claude-haiku-4-5", "claude-sonnet-5", "claude-opus-5"];

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

// Per-request settings: keys come from headers (or server env as a shared
// fallback), the rest from the request body.
function requestSettings(req) {
  const s = (req.body && req.body.settings) || {};
  const sources = { ...DEFAULT_SOURCES };
  for (const k of Object.keys(DEFAULT_SOURCES)) if (typeof s.sources?.[k] === "boolean") sources[k] = s.sources[k];
  return {
    anthropicApiKey: String(req.get("x-anthropic-key") || process.env.ANTHROPIC_API_KEY || "").trim(),
    rapidApiKey: String(req.get("x-rapidapi-key") || process.env.RAPIDAPI_KEY || "").trim(),
    sources,
    jsearchPages: clampInt(s.jsearchPages, 1, 3, 1),
    resultsPerSource: clampInt(s.resultsPerSource, 5, 50, 25),
    models: {
      scoring: MODELS.includes(s.models?.scoring) ? s.models.scoring : "claude-haiku-4-5",
      analysis: MODELS.includes(s.models?.analysis) ? s.models.analysis : "claude-sonnet-5",
    },
    defaultLocation: String(s.defaultLocation || "Singapore").trim() || "Singapore",
  };
}

export const app = express();
app.disable("x-powered-by");

// Vercel may have parsed the JSON body already; only parse it ourselves if not.
const jsonParser = express.json({ limit: "6mb" });
app.use((req, res, next) => {
  if (req.body && typeof req.body === "object") return next();
  jsonParser(req, res, next);
});

// Optional gate: set APP_PASSWORD on the server and the site asks for it once.
app.use("/api", (req, res, next) => {
  const required = process.env.APP_PASSWORD;
  if (!required || req.path === "/meta") return next();
  if (req.get("x-app-password") === required) return next();
  res.status(401).json({ error: "This site needs its access password. Enter it in Settings.", code: "password" });
});

// What the browser needs to know about this deployment.
app.get("/api/meta", (req, res) => {
  res.json({
    sources: Object.values(SOURCES).map((s) => ({ id: s.id, label: s.label, needsKey: s.needsKey })),
    passwordRequired: Boolean(process.env.APP_PASSWORD),
    serverKeys: { anthropic: Boolean(process.env.ANTHROPIC_API_KEY), rapidapi: Boolean(process.env.RAPIDAPI_KEY) },
    hosted: Boolean(process.env.VERCEL || process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.HOSTED),
  });
});

// Search ----------------------------------------------------------------------
app.post("/api/search", async (req, res) => {
  const settings = requestSettings(req);
  const params = normalizeParams(req.body || {}, settings);
  if (!params.query) return res.status(400).json({ error: "Enter a role or keyword to search for." });
  const { jobs, sources } = await runSearch(params, settings, { forceRefresh: Boolean(req.body?.forceRefresh) });
  res.json({ params, jobs, sources, deepLinks: buildDeepLinks(params) });
});

// "Jobs for you": the browser sends the top CV-suggested queries; we run and merge them.
app.post("/api/search/suggested", async (req, res) => {
  const settings = requestSettings(req);
  const queries = (Array.isArray(req.body?.queries) ? req.body.queries : []).map((q) => String(q || "").trim()).filter(Boolean).slice(0, 3);
  if (!queries.length) return res.status(400).json({ error: "No suggested searches — upload a CV first." });
  const location = String(req.body?.location || settings.defaultLocation).trim();

  const runs = await Promise.all(queries.map((query) =>
    runSearch(normalizeParams({ ...(req.body || {}), query, location }, settings), settings, { forceRefresh: Boolean(req.body?.forceRefresh) }),
  ));
  const jobs = mergeJobs(runs.flatMap((r) => r.jobs));

  // Collapse per-query source reports into one line per source.
  const bySource = {};
  for (const r of runs) for (const s of r.sources) {
    const agg = bySource[s.source] || (bySource[s.source] = { source: s.source, label: s.label, count: 0, cached: true });
    if (s.count) agg.count += s.count;
    if (!s.cached) agg.cached = false;
    if (s.error) agg.error = s.error;
    if (s.skipped) agg.skipped = s.skipped;
    if (s.quota) agg.quota = s.quota;
  }

  res.json({
    params: { ...normalizeParams({ ...(req.body || {}), query: "Jobs for you", location }, settings), suggested: true, queries },
    jobs,
    sources: Object.values(bySource),
    deepLinks: buildDeepLinks({ query: queries[0], location }),
  });
});

// AI --------------------------------------------------------------------------
app.post("/api/profile", async (req, res) => {
  const settings = requestSettings(req);
  const cvText = String(req.body?.cvText || "").trim();
  if (cvText.length < 200) return res.status(400).json({ error: "The CV text is too short to build a profile from." });
  if (cvText.length > 60_000) return res.status(400).json({ error: "The CV text is unusually long (over 60,000 characters). Is this the right file?" });
  try {
    const { profile, usage } = await extractProfile(cvText, settings);
    res.json({ profile, usage });
  } catch (err) {
    res.status(502).json({ error: friendlyAiError(err) });
  }
});

app.post("/api/score", async (req, res) => {
  const settings = requestSettings(req);
  const { profile, cvText } = req.body || {};
  const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs.filter((j) => j && j.id && j.title).slice(0, 24) : [];
  if (!profile || !cvText) return res.status(400).json({ error: "Upload a CV first so jobs can be scored against it." });
  if (!jobs.length) return res.json({ scores: {}, usage: null });
  try {
    const { scores, usage } = await scoreJobs(profile, String(cvText), jobs, settings);
    res.json({ scores, usage });
  } catch (err) {
    res.status(502).json({ error: friendlyAiError(err) });
  }
});

app.post("/api/analyze", async (req, res) => {
  const settings = requestSettings(req);
  const { profile, cvText, job } = req.body || {};
  if (!profile || !cvText) return res.status(400).json({ error: "Upload a CV first." });
  if (!job || !job.title) return res.status(400).json({ error: "Job details missing — run the search again." });
  try {
    const { analysis, usage } = await analyzeJob(profile, String(cvText), job, settings);
    res.json({ analysis, usage });
  } catch (err) {
    res.status(502).json({ error: friendlyAiError(err) });
  }
});

app.post("/api/cache/clear", (req, res) => res.json({ cleared: cacheClear() }));

// Each entry point calls this last, after adding any routes of its own.
export function finalize() {
  app.use("/api", (req, res) => res.status(404).json({ error: `No such endpoint: ${req.path}` }));
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "Request too large." });
    console.error(err);
    res.status(500).json({ error: err.message || "Unexpected server error" });
  });
}
