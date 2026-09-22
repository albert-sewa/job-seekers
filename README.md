# Job Seek

A private, local job-search hub for Singapore / SE Asia. One search hits every
platform we can reach by API, merges the duplicates, scores each job against
your CV with Claude, and tracks your applications.

## Start

- **Mac:** double-click **`Start Job Seek.command`**
- **Windows:** double-click **`Start Job Seek.bat`**

Either one installs dependencies the first time, starts a local server and
opens <http://localhost:4747>. Keep that window open while you use the app.
Don't open `index.html` directly — it only works with the server running.
Node.js (LTS, from <https://nodejs.org>) must be installed; the launcher opens
the download page if it isn't.

From a terminal instead:

```bash
npm install
npm start
```

## Hosted version (no install for friends)

### Render (free web service)

Render → **New → Web Service** → connect this GitHub repo. Settings:
Runtime **Node**, Build command `npm install`, Start command `npm start`,
Instance type **Free**. Nothing else is needed. (Free instances sleep after
15 minutes idle; the first visit afterwards takes ~30–60 s to wake up.)

### Vercel

The same app runs on Vercel so friends can use it from any browser — including
locked-down work laptops. Each person's keys, CV profile and tracker are kept
in their own browser; the server stores nothing.

Deploy from this folder (once, needs Node on your Mac):

```bash
npx vercel login
```

```bash
npx vercel --prod
```

Optional environment variables in the Vercel project settings:

- `APP_PASSWORD` — if set, the site asks everyone for this password once.
- `ANTHROPIC_API_KEY` / `RAPIDAPI_KEY` — shared keys so friends don't need
  their own (you pay; the free JSearch quota is then shared too).

## First-time setup (in the app → Settings)

1. **Anthropic API key** — powers the CV profile, match scores and gap analysis.
   Create one at <https://console.anthropic.com/settings/keys>.
2. **RapidAPI key** (free) — unlocks JSearch, which aggregates Google Jobs
   (LinkedIn, Indeed, JobStreet, Glassdoor, MyCareersFuture and company sites).
   Sign up at <https://rapidapi.com>, subscribe to the **Basic (free)** plan on
   <https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing>, and copy
   the `x-rapidapi-key` shown on the Endpoints tab. ~200 searches/month free;
   results are cached for 12 hours so re-running a search costs nothing.
3. **Upload your CV** (My CV tab) — PDF or .docx.

Keys and all data live in your browser's storage (Settings → "Download
backup" to keep a copy). Upgrading from the earlier file-based version? The
local launcher imports `data/settings.json` and `data/profile.json` into the
browser once; you can delete the `data/` folder afterwards.

## Sources

| Source | Key | Coverage |
| --- | --- | --- |
| JSearch (RapidAPI) | RapidAPI key | Google Jobs: LinkedIn, Indeed, JobStreet, Glassdoor, company sites |
| MyCareersFuture | none | Singapore government portal (unofficial API) |
| Remotive | none | Remote jobs worldwide, filtered to ones open to Asia |
| Arbeitnow | none | Remote roles from a mostly-European board (off by default) |

JobStreet, LinkedIn, Indeed, Glassdoor, Glints, Tech in Asia and NodeFlair
have no public API — the app shows "open this search on …" buttons for them.

## AI usage & cost

- Bulk scoring uses **Claude Haiku 4.5** in batches of 8 jobs — roughly
  US$0.002 per job. Scores are cached per CV version, so re-running a search
  doesn't re-score jobs already seen.
- CV profile and per-job gap analysis use **Claude Sonnet 5** — a few cents each.
- Settings shows a running estimate of spend.

## Sharing with friends

Zip the folder **without** `data/` and send it (with `node_modules/` included
it runs offline; without it, the first launch needs internet). Each person
double-clicks the launcher for their system (`.command` on Mac, `.bat` on
Windows), adds their own keys and uploads their own CV.

If macOS says the file "cannot be opened because it is from an unidentified
developer", right-click **Start Job Seek.command** → **Open** → **Open** once;
after that it double-clicks normally. Node.js must be installed
(<https://nodejs.org>, LTS) — the launcher opens the download page if it isn't.

## Data

Everything is in the browser's localStorage for this site (keys `js:*`).
Settings → "Delete all my data" wipes it; "Download backup" / "Restore backup"
moves it between devices.
