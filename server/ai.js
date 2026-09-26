// Everything that talks to Claude: CV → profile, bulk job scoring, and the
// deep gap analysis for a single job. Uses structured outputs so the frontend
// always gets well-formed JSON.
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { clampText } from "./normalize.js";

// USD per million tokens — used only for the running cost estimate in Settings.
const PRICING = {
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-opus-5": { input: 5, output: 25 },
};

// Every call returns its own usage record; the browser keeps the running total.
function usageOf(model, u) {
  const price = PRICING[model] || PRICING["claude-sonnet-5"];
  const input = u?.input_tokens || 0;
  const output = u?.output_tokens || 0;
  const cacheRead = u?.cache_read_input_tokens || 0;
  const cacheWrite = u?.cache_creation_input_tokens || 0;
  const estimatedUsd = (input * price.input + cacheRead * price.input * 0.1 + cacheWrite * price.input * 1.25 + output * price.output) / 1e6;
  return { calls: 1, inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite, estimatedUsd };
}

function addUsage(a, b) {
  return {
    calls: a.calls + b.calls, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens, cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    estimatedUsd: a.estimatedUsd + b.estimatedUsd,
  };
}
const ZERO_USAGE = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0 };

function client(settings) {
  // Falls back to ANTHROPIC_API_KEY / `ant auth login` if no key is pasted in Settings.
  return settings.anthropicApiKey ? new Anthropic({ apiKey: settings.anthropicApiKey }) : new Anthropic();
}

// Translate SDK errors into something a non-developer can act on.
export function friendlyAiError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key is missing or invalid. Add it in Settings.";
  if (err instanceof Anthropic.PermissionDeniedError) return "Anthropic API key doesn't have permission for this model.";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic rate limit hit — wait a minute and try again.";
  if (err instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Anthropic API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status}: ${err.message}`;
  return err.message || String(err);
}

// ---- 1. CV → structured profile + suggested searches ----------------------

const ProfileSchema = z.object({
  name: z.string().nullable().describe("Candidate's name if present"),
  headline: z.string().describe("One-line professional headline, e.g. 'Data analyst with 4 years in fintech'"),
  summary: z.string().describe("2-3 sentence summary of the candidate's background and strengths"),
  yearsExperience: z.number().describe("Total years of relevant work experience (0 for fresh graduates)"),
  seniority: z.enum(["Entry", "Mid", "Senior", "Executive"]),
  currentTitle: z.string().nullable(),
  skills: z.array(z.string()).describe("Hard skills and domain knowledge, most important first, max 25"),
  tools: z.array(z.string()).describe("Software, languages, frameworks, platforms, max 20"),
  industries: z.array(z.string()).describe("Industries worked in"),
  languages: z.array(z.string()).describe("Spoken languages if listed"),
  education: z.array(z.object({
    degree: z.string(),
    institution: z.string(),
    year: z.string().nullable(),
  })),
  experience: z.array(z.object({
    title: z.string(),
    company: z.string(),
    period: z.string().describe("e.g. 'Jan 2021 – Mar 2024'"),
  })).describe("Work history, most recent first, max 8"),
  targetRoles: z.array(z.string()).describe("5-8 job titles this person is a realistic fit for right now"),
  suggestedSearches: z.array(z.object({
    query: z.string().describe("Short search query to type into a job board, 2-4 words"),
    industry: z.string().describe("Which of the candidate's industries/sectors this search targets, or 'Any' for an industry-neutral title"),
    reason: z.string().describe("One sentence on why this search suits the candidate"),
  })).describe("6-8 concrete searches covering EVERY industry in the candidate's background plus industry-neutral titles, best fit first"),
  strengths: z.array(z.string()).describe("3-5 selling points to emphasise"),
  developmentAreas: z.array(z.string()).describe("2-4 gaps that commonly block them from stronger roles"),
});

export async function extractProfile(cvText, settings) {
  const model = settings.models.analysis;
  const response = await client(settings).messages.parse({
    model,
    max_tokens: 8000,
    output_config: { effort: "medium", format: zodOutputFormat(ProfileSchema) },
    system: [
      "You are an experienced recruiter in Singapore who helps job seekers position themselves.",
      "Read the CV and extract a faithful structured profile. Do not invent skills or experience that aren't in the CV.",
      "For suggestedSearches, think about which job titles the Singapore / Southeast Asia market actually uses, and include both the candidate's obvious next role and one or two adjacent roles they could credibly pivot into.",
      "Search queries must be job titles or title + specialism only (e.g. 'Product Analyst' or 'Senior Data Analyst fintech') — never include a city or country, the location is chosen separately.",
      "CRITICAL — cover the candidate's whole background, not just one industry: list every distinct industry or sector in the CV, then make sure the searches span all of them. The most recent employer, or the industry that happens to appear most often, must NOT dominate the list.",
      "Lead with 2-3 industry-NEUTRAL job titles (industry: 'Any') that work across all their sectors, then at most ONE search per specific industry. Never give two searches naming the same industry.",
    ].join(" "),
    messages: [{ role: "user", content: `CV text:\n\n${cvText}` }],
  });
  if (!response.parsed_output) throw new Error("Claude returned an unreadable profile — please try uploading again.");
  return { profile: response.parsed_output, usage: usageOf(model, response.usage) };
}

// ---- 2. Bulk scoring of search results (cheap model, batched) --------------

const BATCH_SIZE = 8;
const PARALLEL_BATCHES = 3;

const ScoreSchema = z.object({
  scores: z.array(z.object({
    id: z.string().describe("The job ID exactly as given, e.g. J3"),
    score: z.number().int().describe("0-100 fit score. 85+ = strong match, 65-84 = good, 45-64 = partial, <45 = weak"),
    verdict: z.enum(["strong", "good", "partial", "weak"]),
    reasons: z.array(z.string()).describe("Up to 3 short phrases (max 12 words each) on why this fits"),
    gaps: z.array(z.string()).describe("Up to 3 short phrases on must-have requirements the candidate lacks; empty if none"),
  })),
});

function profileBrief(profile, cvText) {
  return [
    `Headline: ${profile.headline}`,
    `Seniority: ${profile.seniority} (${profile.yearsExperience} years)`,
    `Current title: ${profile.currentTitle || "n/a"}`,
    `Skills: ${profile.skills.join(", ")}`,
    `Tools: ${profile.tools.join(", ")}`,
    `Industries: ${profile.industries.join(", ")}`,
    `Recent roles: ${profile.experience.slice(0, 4).map((e) => `${e.title} @ ${e.company} (${e.period})`).join("; ")}`,
    `Education: ${profile.education.map((e) => `${e.degree}, ${e.institution}`).join("; ")}`,
    "",
    "Full CV text:",
    clampText(cvText, 9000),
  ].join("\n");
}

function jobBrief(job, alias) {
  const parts = [
    `ID: ${alias}`,
    `Title: ${job.title}`,
    `Company: ${job.company}`,
    `Location: ${job.location || "n/a"}${job.remote ? " (remote)" : ""}`,
    `Type: ${job.employmentType || "n/a"} · Level: ${job.experienceLevel || "n/a"}${job.minYearsExperience != null ? ` · Min ${job.minYearsExperience} yrs` : ""}`,
  ];
  if (job.salary) parts.push(`Salary: ${job.salary.min || "?"}–${job.salary.max || "?"} ${job.salary.currency || ""}/${job.salary.period || "month"}`);
  if (job.skills?.length) parts.push(`Listed skills: ${job.skills.slice(0, 15).join(", ")}`);
  if (job.highlights?.qualifications?.length) parts.push(`Qualifications: ${job.highlights.qualifications.slice(0, 8).join(" | ")}`);
  parts.push(`Description: ${clampText(job.description || "(no description)", 2500)}`);
  return parts.join("\n");
}

export async function scoreJobs(profile, cvText, jobs, settings, onBatch) {
  const model = settings.models.scoring;
  const c = client(settings);
  const brief = profileBrief(profile, cvText);
  const batches = [];
  for (let i = 0; i < jobs.length; i += BATCH_SIZE) batches.push(jobs.slice(i, i + BATCH_SIZE));

  const results = {};
  let usage = ZERO_USAGE;
  let cursor = 0;
  async function worker() {
    while (cursor < batches.length) {
      const batch = batches[cursor++];
      // Short aliases (J1, J2, …) are copied back reliably; raw ids from some
      // sources are 150-character strings that get mangled.
      const alias = (i) => `J${i + 1}`;
      const response = await c.messages.parse({
        model,
        max_tokens: 4000,
        output_config: { format: zodOutputFormat(ScoreSchema) },
        system: [
          "You are a pragmatic recruiter scoring how well a candidate fits each job posting.",
          "Score primarily on: required skills and tools match, seniority and years of experience fit, and hard blockers (e.g. licences, citizenship, language requirements, or the role being far more senior/junior).",
          "Industry is a secondary factor, and the candidate's ENTIRE industry history counts equally — a job in any sector they have worked in is an industry match, not just their most recent or most frequent one. Do not push jobs from one favoured industry to the top: two jobs with the same role fit, in two different industries the candidate has worked in, must score the same.",
          "Where the candidate's core skills transfer cleanly (e.g. B2B sales, account management, analysis), a role in an industry that is new to them can still score 'good'; deduct for industry only when the posting genuinely requires sector-specific knowledge, licensing or an existing client network.",
          "Be discriminating: most jobs should not score above 80. A role requiring skills the candidate has never used should be 'partial' at best.",
          "Return one score object for every job id you are given, in the same order.",
        ].join(" "),
        messages: [{
          role: "user",
          content: `CANDIDATE PROFILE\n${brief}\n\n=====\nJOBS TO SCORE (${batch.length})\n\n${batch.map((j, i) => jobBrief(j, alias(i))).join("\n\n---\n\n")}`,
        }],
      });
      usage = addUsage(usage, usageOf(model, response.usage));
      const out = response.parsed_output?.scores || [];
      for (const s of out) {
        const idx = batch.findIndex((j, i) => alias(i) === String(s.id).trim().toUpperCase() || j.id === s.id);
        if (idx >= 0) {
          results[batch[idx].id] = { score: clampScore(s.score), verdict: s.verdict, reasons: s.reasons.slice(0, 3), gaps: s.gaps.slice(0, 3) };
        }
      }
      if (onBatch) onBatch(results);
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_BATCHES, batches.length) }, worker));
  return { scores: results, usage };
}

function clampScore(n) {
  return Math.max(0, Math.min(100, Math.round(Number(n) || 0)));
}

// ---- 3. Deep gap analysis for one job (stronger model) ---------------------

const AnalysisSchema = z.object({
  fitScore: z.number().int().describe("0-100 overall fit"),
  verdict: z.string().describe("One-sentence bottom line, e.g. 'Apply — strong fit, only minor gaps'"),
  summary: z.string().describe("A short paragraph explaining the fit honestly"),
  requirementsMet: z.array(z.object({
    requirement: z.string(),
    evidence: z.string().describe("Where in the CV this is demonstrated"),
  })),
  requirementsMissing: z.array(z.object({
    requirement: z.string(),
    importance: z.enum(["must-have", "nice-to-have"]),
    howToAddress: z.string().describe("Practical way to close or work around this gap (learn X, reframe Y, mention Z)"),
  })),
  highlightInApplication: z.array(z.string()).describe("3-5 specific CV points to lead with for this job"),
  learnNext: z.array(z.string()).describe("Skills or certifications worth picking up for this kind of role"),
  redFlags: z.array(z.string()).describe("Anything concerning about the posting itself (vague pay, agency, unrealistic scope). Empty if none."),
});

export async function analyzeJob(profile, cvText, job, settings) {
  const model = settings.models.analysis;
  const response = await client(settings).messages.parse({
    model,
    max_tokens: 8000,
    output_config: { effort: "high", format: zodOutputFormat(AnalysisSchema) },
    system: [
      {
        type: "text",
        text: [
          "You are a senior recruiter and career coach in Singapore. Compare the candidate's CV with a job posting and give an honest, specific gap analysis.",
          "Quote the actual requirement wording from the posting where possible. Distinguish must-haves from nice-to-haves. Never invent experience the CV doesn't show.",
        ].join(" "),
      },
      {
        // The CV is identical across analyses, so cache it for back-to-back clicks.
        type: "text",
        text: `CANDIDATE PROFILE\n${profileBrief(profile, cvText)}`,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: [{
      role: "user",
      content: `JOB POSTING\n\nTitle: ${job.title}\nCompany: ${job.company}\nLocation: ${job.location || "n/a"}\nType: ${job.employmentType || "n/a"} · Level: ${job.experienceLevel || "n/a"}\n${job.salary ? `Salary: ${job.salary.min || "?"}–${job.salary.max || "?"} ${job.salary.currency || ""}/${job.salary.period || "month"}\n` : ""}${job.skills?.length ? `Listed skills: ${job.skills.join(", ")}\n` : ""}\nDescription:\n${clampText(job.description || "(no description available)", 14000)}`,
    }],
  });
  if (!response.parsed_output) throw new Error("Claude returned an unreadable analysis — please try again.");
  return {
    analysis: { ...response.parsed_output, fitScore: clampScore(response.parsed_output.fitScore), model, analyzedAt: new Date().toISOString() },
    usage: usageOf(model, response.usage),
  };
}
