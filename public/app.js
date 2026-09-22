/* Job Seek — frontend. Plain JS, no build step.
   All personal data (keys, CV profile, tracker, scores) lives in this browser's
   localStorage; the server is a stateless engine. */
(() => {
  "use strict";

  const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.min.mjs";
  const PDFJS_WORKER_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/6.3.289/pdf.worker.min.mjs";
  const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.12.3/mammoth.browser.min.js";

  const DEFAULT_SETTINGS = {
    anthropicApiKey: "",
    rapidApiKey: "",
    appPassword: "",
    sources: { jsearch: true, mycareersfuture: true, remotive: true, arbeitnow: false },
    jsearchPages: 1,
    resultsPerSource: 25,
    defaultLocation: "Singapore",
    autoScore: true,
    models: { scoring: "claude-haiku-4-5", analysis: "claude-sonnet-5" },
  };
  const ZERO_USAGE = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedUsd: 0, byPurpose: {} };
  const STATUSES = ["saved", "applied", "interview", "offer", "rejected"];
  const SEARCH_CACHE_TTL = 6 * 60 * 60 * 1000;
  const SEARCH_CACHE_MAX = 8;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // ---------- Browser storage ----------
  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem("js:" + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem("js:" + key, JSON.stringify(value)); }
      catch (err) {
        // Out of space: drop the search cache and try once more.
        try { localStorage.removeItem("js:cache"); localStorage.setItem("js:" + key, JSON.stringify(value)); }
        catch { toast("Browser storage is full — some data could not be saved.", "error"); }
      }
    },
    remove(key) { try { localStorage.removeItem("js:" + key); } catch { /* ignore */ } },
  };

  const db = {
    settings: { ...DEFAULT_SETTINGS, ...store.get("settings", {}) },
    profile: store.get("profile", null),        // { fileName, uploadedAt, version, cvText, profile }
    tracker: store.get("tracker", {}),          // key → { key, status, notes, job, createdAt, updatedAt, history }
    hidden: store.get("hidden", {}),            // key → ISO
    seen: store.get("seen", {}),                // key → ISO first seen
    searches: store.get("searches", []),
    history: store.get("history", []),
    scores: store.get("scores", {}),            // `${version}:${key}` → score
    analyses: store.get("analyses", {}),        // `${version}:${key}` → analysis
    usage: { ...ZERO_USAGE, ...store.get("usage", {}) },
  };
  db.settings.sources = { ...DEFAULT_SETTINGS.sources, ...(db.settings.sources || {}) };
  db.settings.models = { ...DEFAULT_SETTINGS.models, ...(db.settings.models || {}) };
  const persist = (name) => store.set(name, db[name]);

  // Keep unbounded maps from growing forever (oldest entries go first).
  function prune(obj, max, timeOf) {
    const keys = Object.keys(obj);
    if (keys.length <= max) return;
    keys.sort((a, b) => (timeOf(obj[a]) < timeOf(obj[b]) ? -1 : 1));
    for (const k of keys.slice(0, keys.length - max)) delete obj[k];
  }

  // ---------- State ----------
  const state = {
    view: "search",
    meta: { sources: [], passwordRequired: false, serverKeys: {}, hosted: false },
    results: null,           // { params, jobs, sources, deepLinks }
    sort: "match",
    showHidden: false,
    scoring: { active: false, done: 0, total: 0 },
    drawerJobId: null,
    savedSearchId: null,
    jsearchQuota: store.get("jsearchQuota", null),
  };

  // ---------- API ----------
  function requestSettings() {
    const s = db.settings;
    return { sources: s.sources, jsearchPages: s.jsearchPages, resultsPerSource: s.resultsPerSource, models: s.models, defaultLocation: s.defaultLocation };
  }

  async function api(path, opts = {}) {
    const init = { method: opts.method || "GET", headers: {} };
    if (db.settings.anthropicApiKey) init.headers["x-anthropic-key"] = db.settings.anthropicApiKey;
    if (db.settings.rapidApiKey) init.headers["x-rapidapi-key"] = db.settings.rapidApiKey;
    if (db.settings.appPassword) init.headers["x-app-password"] = db.settings.appPassword;
    if (opts.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ ...opts.body, settings: requestSettings() });
    }
    let res;
    try { res = await fetch(path, init); }
    catch { throw new Error("Can't reach the server. Check your connection, or restart the app if it's running locally."); }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.code = data?.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function recordUsage(u, purpose) {
    if (!u) return;
    const d = db.usage;
    for (const k of ["calls", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedUsd"]) d[k] = (d[k] || 0) + (u[k] || 0);
    d.byPurpose[purpose] = d.byPurpose[purpose] || { calls: 0, usd: 0 };
    d.byPurpose[purpose].calls += u.calls || 0;
    d.byPurpose[purpose].usd += u.estimatedUsd || 0;
    persist("usage");
    renderSidebar();
  }

  // ---------- Utilities ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(msg, kind = "info", ms = 3500) {
    const el = document.createElement("div");
    el.className = `toast${kind === "error" ? " toast-error" : ""}`;
    el.textContent = msg;
    $("#toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  function timeAgo(iso) {
    if (!iso) return null;
    const diff = Date.now() - new Date(iso).getTime();
    if (!Number.isFinite(diff)) return null;
    const m = Math.round(diff / 60000);
    if (m < 60) return m <= 1 ? "just now" : `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return d === 1 ? "yesterday" : `${d}d ago`;
    const mo = Math.round(d / 30);
    return mo < 12 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
  }

  function fmtMoney(n, currency) {
    if (n == null) return null;
    const sym = { SGD: "S$", USD: "$", EUR: "€", GBP: "£", MYR: "RM", HKD: "HK$", AUD: "A$", INR: "₹" }[currency] || (currency ? currency + " " : "$");
    return sym + Math.round(n).toLocaleString("en-SG");
  }

  function fmtSalary(s) {
    if (!s) return null;
    const period = { month: "/mo", monthly: "/mo", year: "/yr", yearly: "/yr", annual: "/yr", hour: "/hr", hourly: "/hr", day: "/day", week: "/wk" }[s.period] || "/mo";
    if (s.min && s.max && s.min !== s.max) return `${fmtMoney(s.min, s.currency)}–${fmtMoney(s.max, s.currency).replace(/^[^\d]+/, "")}${period}`;
    return `${fmtMoney(s.min || s.max, s.currency)}${period}`;
  }

  const initials = (name) => String(name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const verdictOf = (score) => (score >= 85 ? "strong" : score >= 65 ? "good" : score >= 45 ? "partial" : "weak");
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));

  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, "0") + text.length.toString(16);
  }

  function scoreRing(ai, extraClass = "") {
    if (!ai) return "";
    const v = ai.verdict || verdictOf(ai.score);
    return `<div class="score verdict-${v} ${extraClass}" style="--pct:${ai.score}" title="Claude fit score"><span>${ai.score}</span><small>${v}</small></div>`;
  }

  // ---------- Local bookkeeping on jobs ----------
  const scoreKey = (job) => `${db.profile?.version}:${job.key}`;

  function decorate(jobs, { previousKeys = null } = {}) {
    const now = new Date().toISOString();
    const pv = db.profile?.version;
    const out = jobs.map((j) => {
      const t = db.tracker[j.key];
      const isNew = previousKeys ? !previousKeys.has(j.key) : !db.seen[j.key];
      if (!db.seen[j.key]) db.seen[j.key] = now;
      return {
        ...j,
        tracker: t ? { status: t.status, notes: t.notes } : null,
        hidden: Boolean(db.hidden[j.key]),
        ai: pv ? db.scores[`${pv}:${j.key}`] || null : null,
        hasAnalysis: pv ? Boolean(db.analyses[`${pv}:${j.key}`]) : false,
        isNew,
      };
    });
    prune(db.seen, 4000, (v) => v);
    persist("seen");
    return out;
  }

  function findJob(id) {
    return (state.results?.jobs || []).find((j) => j.id === id) || Object.values(db.tracker).find((t) => t.job.id === id)?.job || null;
  }

  // Search-result cache (per params + source settings) to spare API quota.
  function searchCacheKey(body) {
    return hashText(JSON.stringify({ ...body, forceRefresh: undefined, s: db.settings.sources, p: db.settings.jsearchPages, n: db.settings.resultsPerSource }));
  }
  function cachedSearch(key) {
    const c = store.get("cache", {});
    const hit = c[key];
    return hit && Date.now() - hit.at < SEARCH_CACHE_TTL ? hit.data : null;
  }
  function rememberSearch(key, data) {
    // Don't pin a partial result (a source timed out or failed) for hours.
    if ((data.sources || []).some((s) => s.error)) return;
    const c = store.get("cache", {});
    c[key] = { at: Date.now(), data: { ...data, jobs: data.jobs.map(({ tracker, hidden, ai, hasAnalysis, isNew, ...j }) => j) } };
    prune(c, SEARCH_CACHE_MAX, (v) => v.at);
    store.set("cache", c);
  }

  // ---------- Navigation ----------
  function showView(name) {
    state.view = name;
    $$(".view").forEach((v) => (v.hidden = v.id !== `view-${name}`));
    $$(".nav-item").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
    if (name === "tracker") renderTracker();
    if (name === "profile") renderProfile();
    if (name === "settings") renderSettings();
    if (name === "search" && !state.results) renderSearchEmpty();
    window.scrollTo({ top: 0 });
  }

  $$(".nav-item").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

  // ---------- Bootstrap ----------
  async function init() {
    if (location.protocol === "file:") {
      // Someone double-clicked index.html instead of starting the server.
      document.querySelector(".main").innerHTML = `<div class="empty-state" style="max-width:560px;margin:60px auto;text-align:left">
        <h2>Job Seek needs its local server running</h2>
        <p>You opened <code>index.html</code> directly, so nothing can search or score. Close this tab and start the app instead:</p>
        <ul class="list"><li><strong>Mac:</strong> double-click <code>Start Job Seek.command</code></li><li><strong>Windows:</strong> double-click <code>Start Job Seek.bat</code></li></ul>
        <p>It opens the app at <a href="http://localhost:4747">http://localhost:4747</a> automatically. Keep that window open while you use it.</p></div>`;
      return;
    }
    try {
      state.meta = await api("/api/meta");
    } catch (err) {
      toast(err.message, "error", 8000);
    }
    await importLegacyData();
    restoreLastSearch();
    $("#for-me-btn").hidden = !db.profile;
    renderSidebar();
    renderSearchEmpty();
    updateTrackerBadge();
    if (state.meta.passwordRequired && !db.settings.appPassword) {
      toast("This site needs an access password — enter it in Settings.", "info", 8000);
      showView("settings");
    } else if (!db.profile && !hasAnthropicKey()) {
      toast("Welcome! Add your API keys in Settings, then upload your CV.", "info", 6000);
    }
  }

  // Running locally after upgrading from the file-based version: pull the old
  // keys and CV profile into this browser once.
  async function importLegacyData() {
    if (state.meta.hosted || db.settings.anthropicApiKey || db.profile || store.get("legacyImported", false)) return;
    try {
      const legacy = await api("/api/legacy");
      if (!legacy?.found) return;
      const ls = legacy.settings || {};
      for (const k of ["anthropicApiKey", "rapidApiKey", "defaultLocation", "autoScore", "jsearchPages", "resultsPerSource"]) if (ls[k] !== undefined) db.settings[k] = ls[k];
      if (ls.sources) db.settings.sources = { ...db.settings.sources, ...ls.sources };
      if (ls.models) db.settings.models = { ...db.settings.models, ...ls.models };
      persist("settings");
      if (legacy.profile?.cvText && legacy.profile?.profile) {
        db.profile = { fileName: legacy.profile.fileName, uploadedAt: legacy.profile.uploadedAt, version: hashText(legacy.profile.cvText), cvText: legacy.profile.cvText, profile: legacy.profile.profile };
        persist("profile");
      }
      store.set("legacyImported", true);
      toast("Imported your keys and CV profile from the previous version.", "info", 6000);
    } catch { /* nothing to import */ }
  }

  const hasAnthropicKey = () => Boolean(db.settings.anthropicApiKey || state.meta.serverKeys?.anthropic);
  const hasRapidKey = () => Boolean(db.settings.rapidApiKey || state.meta.serverKeys?.rapidapi);

  function renderSidebar() {
    const box = $("#sidebar-profile");
    if (db.profile) {
      const pr = db.profile.profile;
      box.innerHTML = `<strong>${esc(pr.name || "Your profile")}</strong><span>${esc(pr.headline)}</span>`;
    } else {
      box.innerHTML = `<span class="empty">No CV yet — <a data-go="profile">upload one</a> to unlock AI matching.</span>`;
      $("a[data-go]", box).addEventListener("click", () => showView("profile"));
    }
    const u = db.usage;
    $("#sidebar-usage").innerHTML = u && u.calls ? `AI spend ≈ $${u.estimatedUsd.toFixed(3)} · ${u.calls} calls` : "";
  }

  function updateTrackerBadge() {
    const active = Object.values(db.tracker).filter((i) => i.status !== "rejected").length;
    const el = $("#tracker-count");
    el.hidden = !active;
    el.textContent = active;
  }

  // ---------- Search form & filters ----------
  const qInput = $("#q");
  const locInput = $("#loc");

  function readParams() {
    const chips = (name) => $$(`.chips[data-filter="${name}"] .chip.is-on`).map((c) => c.dataset.value);
    return {
      query: qInput.value.trim(),
      location: locInput.value.trim() || db.settings.defaultLocation || "Singapore",
      employmentTypes: chips("employmentTypes"),
      experienceLevels: chips("experienceLevels"),
      workArrangement: chips("workArrangement")[0] || "any",
      datePosted: $("#datePosted").value,
      salaryMin: $("#salaryMin").value ? Number($("#salaryMin").value) : null,
      salaryMax: $("#salaryMax").value ? Number($("#salaryMax").value) : null,
      excludeKeywords: $("#excludeKeywords").value.trim(),
    };
  }

  function writeParams(p) {
    qInput.value = p.query || "";
    locInput.value = p.location || "";
    $$(".chips[data-filter] .chip").forEach((c) => {
      const f = c.closest(".chips").dataset.filter;
      const on = f === "workArrangement" ? (p.workArrangement || "any") === c.dataset.value : (p[f] || []).includes(c.dataset.value);
      c.classList.toggle("is-on", on);
    });
    $("#datePosted").value = p.datePosted || "all";
    $("#salaryMin").value = p.salaryMin || "";
    $("#salaryMax").value = p.salaryMax || "";
    $("#excludeKeywords").value = Array.isArray(p.excludeKeywords) ? p.excludeKeywords.join(", ") : (p.excludeKeywords || "");
  }

  function restoreLastSearch() {
    const last = store.get("lastParams", null);
    if (last) writeParams(last);
    applyDefaultLocation();
  }

  // The Settings "default location" wins on every load; the user can still
  // type a different one for a single search.
  function applyDefaultLocation() {
    const def = db.settings.defaultLocation || "Singapore";
    locInput.value = def;
    locInput.placeholder = def;
  }

  $$(".chips").forEach((group) => {
    group.addEventListener("click", (e) => {
      const chip = e.target.closest(".chip");
      if (!chip) return;
      if (group.classList.contains("chips-single")) {
        $$(".chip", group).forEach((c) => c.classList.toggle("is-on", c === chip));
      } else {
        chip.classList.toggle("is-on");
      }
      if (state.results) rerun();
    });
  });
  ["#datePosted", "#salaryMin", "#salaryMax", "#excludeKeywords"].forEach((sel) => {
    $(sel).addEventListener("change", () => { if (state.results) rerun(); });
  });
  $("#clear-filters").addEventListener("click", () => {
    writeParams({ query: qInput.value, location: locInput.value });
    if (state.results) rerun();
  });
  $("#for-me-btn").addEventListener("click", () => runSuggested());

  function rerun(opts = {}) {
    if (state.results?.params?.suggested) return runSuggested(opts);
    return runSearch(opts);
  }

  $("#search-form").addEventListener("submit", (e) => { e.preventDefault(); hideSuggest(); runSearch(); });
  qInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideSuggest();
    if (e.key === "Enter") { e.preventDefault(); hideSuggest(); runSearch(); }
  });
  locInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runSearch(); } });
  $("#refresh-btn").addEventListener("click", () => rerun({ forceRefresh: true }));
  $("#show-hidden").addEventListener("change", (e) => { state.showHidden = e.target.checked; renderResults(); });
  $("#sort").addEventListener("change", (e) => { state.sort = e.target.value; renderResults(); });
  $("#save-search-btn").addEventListener("click", saveCurrentSearch);

  // Query suggestions (from CV + history)
  function suggestions(text) {
    const t = text.toLowerCase();
    const fromCv = (db.profile?.profile?.suggestedSearches || []).filter((s) => !t || s.query.toLowerCase().includes(t));
    const fromHistory = db.history.filter((h) => (!t || h.toLowerCase().includes(t)) && !fromCv.some((s) => s.query.toLowerCase() === h.toLowerCase()));
    return { fromCv, fromHistory };
  }
  function showSuggest() {
    const { fromCv, fromHistory } = suggestions(qInput.value.trim());
    const box = $("#suggest");
    if (!fromCv.length && !fromHistory.length) return hideSuggest();
    box.innerHTML = [
      fromCv.length ? `<div class="suggest-head">Suggested from your CV</div>` + fromCv.map((s) => `<button type="button" class="suggest-item" data-q="${esc(s.query)}">${esc(s.query)}<span class="why">${esc(s.reason)}</span></button>`).join("") : "",
      fromHistory.length ? `<div class="suggest-head">Recent</div>` + fromHistory.slice(0, 6).map((h) => `<button type="button" class="suggest-item" data-q="${esc(h)}">${esc(h)}</button>`).join("") : "",
    ].join("");
    box.hidden = false;
  }
  function hideSuggest() { $("#suggest").hidden = true; }
  qInput.addEventListener("focus", showSuggest);
  qInput.addEventListener("input", showSuggest);
  document.addEventListener("click", (e) => { if (!e.target.closest(".field-query")) hideSuggest(); });
  $("#suggest").addEventListener("click", (e) => {
    const b = e.target.closest(".suggest-item");
    if (!b) return;
    qInput.value = b.dataset.q;
    hideSuggest();
    runSearch();
  });

  // ---------- Running searches ----------
  let searchSeq = 0;

  function beginSearch(message) {
    const seq = ++searchSeq;
    $("#search-empty").hidden = true;
    $("#results-wrap").hidden = false;
    $("#results-summary").innerHTML = `<span class="spinner"></span> ${message}`;
    $("#results").innerHTML = "";
    $("#source-status").innerHTML = "";
    return seq;
  }

  function showResults(data) {
    state.results = data;
    rememberQuota(data.sources);
    state.sort = db.profile ? "match" : "relevance";
    $("#sort").value = state.sort;
    renderResults();
    renderSourceStatus();
    renderDeepLinks();
    if (db.profile && db.settings.autoScore) scoreUnscored();
  }

  function showSearchError(err) {
    $("#results-summary").textContent = "";
    $("#results").innerHTML = `<div class="callout">${esc(err.message)}${err.code === "password" ? ` <button class="btn btn-sm" data-go="settings">Open Settings</button>` : ""}</div>`;
    $$("[data-go]", $("#results")).forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
  }

  async function runSearch({ forceRefresh = false, savedSearch = null } = {}) {
    const params = savedSearch ? savedSearch.params : readParams();
    if (!params.query) { qInput.focus(); return; }
    if (savedSearch) writeParams(params);
    store.set("lastParams", params);
    state.savedSearchId = savedSearch ? savedSearch.id : null;

    const seq = beginSearch(`Searching ${enabledSourceCount()} sources…`);
    const btn = $("#search-btn");
    btn.disabled = true; btn.textContent = "Searching…";
    try {
      const body = { ...params };
      const cacheKey = searchCacheKey(body);
      let data = forceRefresh ? null : cachedSearch(cacheKey);
      if (data) data = { ...data, sources: data.sources.map((s) => ({ ...s, cached: true })) };
      else {
        data = await api("/api/search", { method: "POST", body: { ...body, forceRefresh } });
        rememberSearch(cacheKey, data);
      }
      if (seq !== searchSeq) return;

      const previous = savedSearch ? new Set(savedSearch.lastResultKeys || []) : null;
      data.jobs = decorate(data.jobs, { previousKeys: previous });
      if (savedSearch) {
        savedSearch.lastRunAt = new Date().toISOString();
        savedSearch.lastResultKeys = data.jobs.map((j) => j.key);
        savedSearch.newCount = data.jobs.filter((j) => j.isNew && !j.hidden).length;
        persist("searches");
      }
      db.history = [params.query, ...db.history.filter((q) => q !== params.query)].slice(0, 20);
      persist("history");
      showResults(data);
    } catch (err) {
      if (seq !== searchSeq) return;
      showSearchError(err);
    } finally {
      if (seq === searchSeq) { btn.disabled = false; btn.textContent = "Search"; }
    }
  }

  // "Jobs for you": the top CV-suggested searches, run together and merged.
  async function runSuggested({ forceRefresh = false } = {}) {
    if (!db.profile) { showView("profile"); return; }
    const queries = (db.profile.profile.suggestedSearches || []).slice(0, 3).map((s) => s.query);
    const filters = { ...readParams(), query: undefined };
    showView("search");
    const seq = beginSearch("Finding jobs that match your CV…");
    state.savedSearchId = null;
    try {
      const body = { ...filters, queries };
      const cacheKey = searchCacheKey(body);
      let data = forceRefresh ? null : cachedSearch(cacheKey);
      if (data) data = { ...data, sources: data.sources.map((s) => ({ ...s, cached: true })) };
      else {
        data = await api("/api/search/suggested", { method: "POST", body: { ...body, forceRefresh } });
        rememberSearch(cacheKey, data);
      }
      if (seq !== searchSeq) return;
      qInput.value = "";
      data.jobs = decorate(data.jobs);
      showResults(data);
    } catch (err) {
      if (seq !== searchSeq) return;
      showSearchError(err);
    }
  }

  function enabledSourceCount() {
    return Object.values(db.settings.sources).filter(Boolean).length || 1;
  }

  function rememberQuota(sources) {
    const js = (sources || []).find((s) => s.source === "jsearch");
    if (js?.quota?.limit) {
      state.jsearchQuota = { ...js.quota, at: new Date().toISOString() };
      store.set("jsearchQuota", state.jsearchQuota);
    }
  }

  // ---------- Rendering results ----------
  const postedCmp = (a, b) => new Date(b.postedAt || 0) - new Date(a.postedAt || 0);

  function visibleJobs() {
    const jobs = (state.results?.jobs || []).filter((j) => state.showHidden || !j.hidden);
    const sorters = {
      match: (a, b) => (b.ai?.score ?? -1) - (a.ai?.score ?? -1) || postedCmp(a, b),
      newest: postedCmp,
      salary: (a, b) => (b.salary?.max || b.salary?.min || 0) - (a.salary?.max || a.salary?.min || 0),
      relevance: () => 0,
    };
    // Keep order stable while scores are still arriving so cards don't jump.
    const sort = state.sort === "match" && state.scoring.active ? "relevance" : state.sort;
    return [...jobs].sort(sorters[sort] || sorters.relevance);
  }

  function renderResults() {
    const all = state.results?.jobs || [];
    const jobs = visibleJobs();
    const hiddenCount = all.filter((j) => j.hidden).length;
    const newCount = all.filter((j) => j.isNew && !j.hidden).length;
    const p = state.results.params;
    const salaryFilter = p.salaryMin || p.salaryMax;

    const what = p.suggested
      ? `suggested for you <span class="muted">in ${esc(p.location)} · based on: ${p.queries.map((q) => `“${esc(q)}”`).join(", ")}</span>`
      : `<span class="muted">for “${esc(p.query)}” in ${esc(p.location)}</span>`;
    $("#results-summary").innerHTML = `${jobs.length} job${jobs.length === 1 ? "" : "s"} ${what}<span class="muted">${newCount ? ` · <strong>${newCount} new</strong>` : ""}${hiddenCount && !state.showHidden ? ` · ${hiddenCount} hidden` : ""}</span>`;
    $("#save-search-btn").hidden = Boolean(p.suggested);

    const box = $("#results");
    if (!jobs.length) {
      const problems = (state.results.sources || []).filter((s) => s.skipped || s.error);
      const needsKey = problems.some((s) => s.skipped && /key/i.test(s.skipped));
      box.innerHTML = `<div class="empty-state"><h2>No results</h2>
        ${problems.length ? `<p>Not every source could search this: ${problems.map((s) => `<strong>${esc(s.label)}</strong> — ${esc(s.skipped || s.error)}`).join("; ")}.</p>` : ""}
        ${needsKey ? `<p>Outside Singapore, JSearch is the main source — <a data-go="settings">add your RapidAPI key in Settings</a>.</p>` : `<p>Try fewer filters, a broader keyword, or open the same search on the platforms below.</p>`}
      </div>`;
      $$("[data-go]", box).forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
      return;
    }
    if (salaryFilter) {
      const withSalary = jobs.filter((j) => !j.salaryUnknown);
      const without = jobs.filter((j) => j.salaryUnknown);
      box.innerHTML = withSalary.map(jobCard).join("") +
        (without.length ? `<div class="results-divider">No salary listed · ${without.length}</div>` + without.map(jobCard).join("") : "");
    } else {
      box.innerHTML = jobs.map(jobCard).join("");
    }
  }

  function jobCard(j) {
    const salary = fmtSalary(j.salary);
    const posted = timeAgo(j.postedAt);
    const publishers = [...new Set((j.sources || []).map((s) => s.publisher || s.sourceLabel))];
    const meta = [
      j.location, j.remote ? "Remote" : null, j.employmentType, j.experienceLevel ? `${j.experienceLevel} level` : null,
      j.minYearsExperience != null ? `${j.minYearsExperience}+ yrs` : null,
    ].filter(Boolean);
    const scoreHtml = j.ai
      ? scoreRing(j.ai)
      : db.profile && (state.scoring.active || db.settings.autoScore) && !j.hidden
        ? `<div class="score pending"><span>scoring…</span></div>`
        : "";
    const aiLine = j.ai
      ? `<div class="job-ai">${(j.ai.reasons || []).slice(0, 2).map((r) => `<span class="r">${esc(r)}</span>`).join("")}${(j.ai.gaps || []).slice(0, 1).map((g) => `<span class="g">${esc(g)}</span>`).join("")}</div>`
      : "";
    const tracked = j.tracker?.status;
    return `
      <article class="job${j.hidden ? " is-hidden" : ""}${tracked ? " is-tracked" : ""}" data-id="${esc(j.id)}">
        <div class="logo">${j.companyLogo ? `<img src="${esc(j.companyLogo)}" alt="" loading="lazy" onerror="this.replaceWith(document.createTextNode('${esc(initials(j.company))}'))">` : esc(initials(j.company))}</div>
        <div class="job-body">
          <h3 class="job-title">${esc(j.title)}${j.isNew ? `<span class="new">New</span>` : ""}${tracked ? `<span class="tag" style="text-transform:capitalize">${esc(tracked)}</span>` : ""}</h3>
          <div class="job-company">${esc(j.company)}</div>
          <div class="job-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}${salary ? `<span class="salary">${esc(salary)}</span>` : ""}${posted ? `<span>${esc(posted)}</span>` : ""}</div>
          <div class="job-tags">${publishers.map((p) => `<span class="tag tag-src">${esc(p)}</span>`).join("")}${(j.skills || []).slice(0, 5).map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div>
          ${aiLine}
        </div>
        <div class="job-side">
          ${scoreHtml}
          <div class="job-actions">
            <button class="btn-icon${tracked ? " is-on" : ""}" data-act="save" title="${tracked ? "Saved — click to remove" : "Save to tracker"}"><svg viewBox="0 0 20 20"><path d="M10 2.8l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" fill="${tracked ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg></button>
            <button class="btn-icon${j.hidden ? " is-on" : ""}" data-act="hide" title="${j.hidden ? "Unhide" : "Hide this job"}"><svg viewBox="0 0 20 20"><path d="M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="10" cy="10" r="2.3" fill="none" stroke="currentColor" stroke-width="1.5"/>${j.hidden ? "" : `<path d="M4 16L16 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`}</svg></button>
            <a class="btn-icon" href="${esc(j.url || "#")}" target="_blank" rel="noopener" data-act="open" title="Open job posting"><svg viewBox="0 0 20 20"><path d="M11 3h6v6M17 3l-8 8M15 11v5H4V5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg></a>
          </div>
        </div>
      </article>`;
  }

  $("#results").addEventListener("click", (e) => {
    const card = e.target.closest(".job");
    if (!card) return;
    const job = findJob(card.dataset.id);
    if (!job) return;
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "open") { e.stopPropagation(); return; }
    if (act === "save") { e.stopPropagation(); return toggleSave(job); }
    if (act === "hide") { e.stopPropagation(); return toggleHide(job); }
    openDrawer(job.id);
  });

  function renderSourceStatus() {
    const box = $("#source-status");
    box.innerHTML = (state.results?.sources || []).map((s) => {
      if (s.error && s.count) return `<span class="pill pill-warn" title="${esc(s.error)}">${esc(s.label)}: ${s.count} · partial</span>`;
      if (s.error) return `<span class="pill pill-err" title="${esc(s.error)}">${esc(s.label)}: error</span>`;
      if (s.skipped) {
        const needsKey = /key/i.test(s.skipped);
        return `<span class="pill pill-warn" title="${esc(s.skipped)}">${esc(s.label)}: ${needsKey ? `<button data-go="settings">add key</button>` : "skipped"}</span>`;
      }
      return `<span class="pill pill-ok">${esc(s.label)}: ${s.count ?? 0}${s.cached ? " · cached" : ""}</span>`;
    }).join("") + (state.jsearchQuota ? `<span class="pill pill-quiet" title="RapidAPI monthly quota, as of ${esc(timeAgo(state.jsearchQuota.at))}">JSearch quota ${state.jsearchQuota.remaining}/${state.jsearchQuota.limit}</span>` : "");
    $$("[data-go]", box).forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
  }

  function renderDeepLinks() {
    const links = state.results?.deepLinks || [];
    $("#deeplinks").innerHTML = `<h3>Same search on other platforms</h3><p class="muted small">These sites don't offer an API — each button opens a pre-filled search in a new tab.</p><div class="deeplinks-row">${links.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`).join("")}</div>`;
  }

  function renderSearchEmpty() {
    const box = $("#search-empty");
    box.hidden = false;
    $("#results-wrap").hidden = true;
    const pr = db.profile?.profile;
    const keysMissing = !hasAnthropicKey() || !hasRapidKey();
    const parts = [];
    if (keysMissing) {
      parts.push(`<div class="callout" style="text-align:left;max-width:640px;margin:0 auto 20px">Some sources or AI features are off until you add keys. <button data-go="settings" class="btn btn-sm" style="margin-left:6px">Open Settings</button></div>`);
    }
    if (pr) {
      parts.push(`<h2>Jobs picked for your CV</h2><p>Based on <strong>${esc(db.profile.fileName)}</strong>.</p><p><button class="btn btn-primary" data-for-me>✦ Show jobs for me</button></p><p class="muted small" style="margin-top:18px">Or run one suggested search on its own:</p><div class="suggested">${pr.suggestedSearches.map((s) => `<button data-q="${esc(s.query)}" title="${esc(s.reason)}">${esc(s.query)}</button>`).join("")}</div>`);
    } else {
      parts.push(`<h2>Search every platform at once</h2><p>Type a role above to search. <a data-go="profile">Upload your CV</a> to get suggested searches and a fit score on every result.</p>`);
    }
    if (db.searches.length) {
      parts.push(`<div class="saved-searches"><h3>Saved searches</h3>${db.searches.map((s) => `
        <div class="saved-search" data-id="${esc(s.id)}">
          <button class="name" data-run="${esc(s.id)}">${esc(s.name)}</button>
          ${s.newCount ? `<span class="badge-new">${s.newCount} new</span>` : ""}
          <span class="meta">${s.lastRunAt ? `ran ${esc(timeAgo(s.lastRunAt))}` : "never run"}</span>
          <button class="btn btn-ghost btn-xs" data-del="${esc(s.id)}" title="Delete saved search">✕</button>
        </div>`).join("")}</div>`);
    }
    box.innerHTML = parts.join("");
    $$("[data-go]", box).forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
    $$("[data-q]", box).forEach((b) => b.addEventListener("click", () => { qInput.value = b.dataset.q; runSearch(); }));
    $$("[data-for-me]", box).forEach((b) => b.addEventListener("click", () => runSuggested()));
    $$("[data-run]", box).forEach((b) => b.addEventListener("click", () => {
      const s = db.searches.find((x) => x.id === b.dataset.run);
      if (s) runSearch({ savedSearch: s, forceRefresh: true });
    }));
    $$("[data-del]", box).forEach((b) => b.addEventListener("click", () => {
      db.searches = db.searches.filter((x) => x.id !== b.dataset.del);
      persist("searches");
      renderSearchEmpty();
    }));
  }

  function saveCurrentSearch() {
    if (!state.results) return;
    const p = state.results.params;
    const name = window.prompt("Name this search:", p.query + (p.location ? ` · ${p.location}` : ""));
    if (name === null) return;
    const search = {
      id: uuid(),
      name: String(name || p.query).trim().slice(0, 80),
      params: p,
      createdAt: new Date().toISOString(),
      lastRunAt: new Date().toISOString(),
      lastResultKeys: state.results.jobs.map((j) => j.key),
      newCount: 0,
    };
    db.searches.push(search);
    persist("searches");
    state.savedSearchId = search.id;
    toast(`Saved “${search.name}”. Re-run it from the Search home to see what's new.`);
  }

  // ---------- Save / hide ----------
  function setTrackerStatus(job, status) {
    const existing = db.tracker[job.key];
    const now = new Date().toISOString();
    const { tracker, hidden, ai, hasAnalysis, isNew, ...snapshot } = job;
    const entry = {
      key: job.key,
      status,
      notes: existing?.notes || "",
      job: snapshot,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      history: [...(existing?.history || [])],
    };
    if (!existing || existing.status !== status) entry.history.push({ status, at: now });
    db.tracker[job.key] = entry;
    persist("tracker");
    job.tracker = { status, notes: entry.notes };
    syncTrackerIntoResults();
  }

  function removeTracker(job) {
    delete db.tracker[job.key];
    persist("tracker");
    job.tracker = null;
    syncTrackerIntoResults();
  }

  function syncTrackerIntoResults() {
    for (const j of state.results?.jobs || []) {
      const t = db.tracker[j.key];
      j.tracker = t ? { status: t.status, notes: t.notes } : null;
    }
    updateTrackerBadge();
  }

  function toggleSave(job) {
    if (job.tracker) { removeTracker(job); toast("Removed from tracker"); }
    else { setTrackerStatus(job, "saved"); toast("Saved to tracker"); }
    renderResults();
    if (state.drawerJobId === job.id) openDrawer(job.id);
  }

  function toggleHide(job) {
    if (job.hidden) { delete db.hidden[job.key]; job.hidden = false; }
    else { db.hidden[job.key] = new Date().toISOString(); job.hidden = true; toast("Hidden — it won't show up in future searches", "info", 2500); }
    persist("hidden");
    renderResults();
    if (state.drawerJobId === job.id) closeDrawer();
  }

  // ---------- AI: CV → profile ----------
  function cleanText(text) {
    return String(text || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Couldn't load the document reader — check your internet connection."));
      document.head.appendChild(s);
    });
  }

  // The CV file never leaves the browser: text is extracted here, and only
  // that text is sent to Claude.
  async function extractCvText(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      let pdfjs;
      try { pdfjs = await import(PDFJS_URL); }
      catch { throw new Error("Couldn't load the PDF reader — check your internet connection, or paste the CV text instead."); }
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      let text = "";
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const content = await page.getTextContent();
        for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : " ");
        text += "\n";
      }
      text = cleanText(text);
      if (text.length < 200) throw new Error("Almost no text could be read from this PDF — it may be a scanned image. Export the CV as a text PDF or .docx, or paste the text instead.");
      return text;
    }
    if (name.endsWith(".docx")) {
      await loadScript(MAMMOTH_URL);
      const out = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      const text = cleanText(out.value);
      if (text.length < 200) throw new Error("The document seems to be empty.");
      return text;
    }
    if (name.endsWith(".doc")) throw new Error("Old .doc files aren't supported — save the CV as .docx or PDF and try again.");
    throw new Error("Unsupported file type. Upload a PDF or .docx file.");
  }

  async function buildProfile(cvText, fileName) {
    const status = $("#upload-status");
    status.hidden = false;
    status.innerHTML = `<span class="spinner"></span> Claude is reading ${esc(fileName)} and building your profile… this takes 15–40 seconds.`;
    try {
      const { profile, usage } = await api("/api/profile", { method: "POST", body: { cvText } });
      recordUsage(usage, "profile");
      db.profile = { fileName, uploadedAt: new Date().toISOString(), version: hashText(cvText), cvText, profile };
      persist("profile");
      for (const j of state.results?.jobs || []) j.ai = null;
      $("#for-me-btn").hidden = false;
      renderSidebar(); renderProfile();
      toast("Profile ready — finding jobs that match your CV…");
      runSuggested();
    } catch (err) {
      status.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
    }
  }

  async function uploadCv(file) {
    const status = $("#upload-status");
    status.hidden = false;
    status.innerHTML = `<span class="spinner"></span> Reading ${esc(file.name)}…`;
    let cvText;
    try { cvText = await extractCvText(file); }
    catch (err) { status.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`; return; }
    await buildProfile(cvText, file.name);
  }

  // ---------- AI scoring ----------
  function jobForAi(j) {
    return {
      id: j.id, key: j.key, title: j.title, company: j.company, location: j.location, remote: j.remote,
      employmentType: j.employmentType, experienceLevel: j.experienceLevel, minYearsExperience: j.minYearsExperience,
      salary: j.salary, skills: (j.skills || []).slice(0, 20),
      highlights: { qualifications: (j.highlights?.qualifications || []).slice(0, 10) },
      description: String(j.description || "").slice(0, 14000),
    };
  }

  async function scoreUnscored() {
    const jobs = (state.results?.jobs || []).filter((j) => !j.ai && !j.hidden);
    if (!jobs.length || !db.profile) return;
    const chunks = [];
    for (let i = 0; i < jobs.length; i += 8) chunks.push(jobs.slice(i, i + 8));
    state.scoring = { active: true, done: 0, total: jobs.length };
    const resultsRef = state.results;
    const version = db.profile.version;
    renderScoreProgress();
    let failed = null;
    let cursor = 0;
    async function worker() {
      while (cursor < chunks.length && !failed) {
        const chunk = chunks[cursor++];
        try {
          const { scores, usage } = await api("/api/score", { method: "POST", body: { profile: db.profile.profile, cvText: db.profile.cvText, jobs: chunk.map(jobForAi) } });
          recordUsage(usage, "scoring");
          const now = new Date().toISOString();
          for (const j of chunk) if (scores[j.id]) {
            db.scores[`${version}:${j.key}`] = { ...scores[j.id], scoredAt: now };
            if (state.results === resultsRef) j.ai = db.scores[`${version}:${j.key}`];
          }
          prune(db.scores, 2000, (v) => v.scoredAt || "");
          persist("scores");
        } catch (err) {
          failed = err.message;
        }
        state.scoring.done += chunk.length;
        renderScoreProgress();
        if (state.results === resultsRef) renderResults();
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, chunks.length) }, worker));
    state.scoring.active = false;
    renderScoreProgress();
    if (state.results === resultsRef) renderResults();
    if (failed) toast(`Scoring stopped: ${failed}`, "error", 6000);
  }

  function renderScoreProgress() {
    const el = $("#score-progress");
    if (!state.scoring.active) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span class="spinner"></span> Claude is scoring jobs against your CV… ${Math.min(state.scoring.done, state.scoring.total)}/${state.scoring.total}`;
  }

  // ---------- Drawer ----------
  const drawer = $("#drawer");
  const backdrop = $("#drawer-backdrop");
  function closeDrawer() { drawer.hidden = true; backdrop.hidden = true; state.drawerJobId = null; }
  backdrop.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !drawer.hidden) closeDrawer(); });

  function openDrawer(id) {
    const job = findJob(id);
    if (!job) return;
    state.drawerJobId = id;
    drawer.hidden = false; backdrop.hidden = false;
    drawer.scrollTop = 0;
    const analysis = db.profile ? db.analyses[scoreKey(job)] || null : null;
    renderDrawer(job, analysis, {});
  }

  function renderDrawer(job, analysis, { loadingAnalysis }) {
    const salary = fmtSalary(job.salary);
    const meta = [job.location, job.remote ? "Remote" : null, job.employmentType, job.experienceLevel ? `${job.experienceLevel} level` : null, job.minYearsExperience != null ? `${job.minYearsExperience}+ yrs experience` : null, salary, job.postedAt ? `Posted ${timeAgo(job.postedAt)}` : null, job.extra?.applicants != null ? `${job.extra.applicants} applicants` : null].filter(Boolean);
    const apply = job.applyOptions?.length ? job.applyOptions : job.url ? [{ publisher: "Apply", url: job.url }] : [];
    const desc = job.description || "No description was provided by the source. Open the posting to read it.";
    const longDesc = desc.length > 1800;
    const tracked = db.tracker[job.key];

    $("#drawer-content").innerHTML = `
      <div class="drawer-top">
        <div>
          <h2>${esc(job.title)}</h2>
          <div class="drawer-company">${esc(job.company)}</div>
        </div>
        <button class="drawer-close" data-close title="Close">✕</button>
      </div>
      <div class="drawer-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join("")}</div>
      <div class="drawer-actions">
        ${apply.length === 1 ? `<a class="btn btn-primary" href="${esc(apply[0].url)}" target="_blank" rel="noopener">Apply on ${esc(apply[0].publisher)} ↗</a>` : apply.length ? `
          <div class="apply-menu"><button class="btn btn-primary" data-apply-toggle>Apply ▾</button><div class="apply-menu-list" hidden>${apply.map((a) => `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.publisher)} ↗</a>`).join("")}</div></div>` : ""}
        <select class="select status-select" data-status>
          <option value="">Not tracked</option>
          ${STATUSES.map((s) => `<option value="${s}" ${tracked?.status === s ? "selected" : ""}>${s[0].toUpperCase() + s.slice(1)}</option>`).join("")}
        </select>
        <button class="btn btn-ghost btn-sm" data-hide>${job.hidden ? "Unhide" : "Hide"}</button>
      </div>
      ${tracked ? `<div class="section"><h3>Notes</h3><textarea data-notes placeholder="Contact person, interview dates, follow-ups…">${esc(tracked.notes || "")}</textarea><div class="muted small" data-notes-state></div></div>` : ""}

      <div class="section">
        <h3>Fit analysis</h3>
        ${!db.profile ? `<p class="muted">Upload your CV to get a gap analysis for this job. <a data-go="profile">Go to My CV</a></p>` :
          loadingAnalysis ? `<div class="progress-note"><span class="spinner"></span> Claude (${esc(db.settings.models.analysis)}) is comparing your CV with this posting… about 30 seconds.</div>` :
          analysis ? analysisHtml(analysis) :
          `<p class="muted small">${job.ai ? `Quick score: <strong>${job.ai.score}</strong> (${job.ai.verdict}). ` : ""}Run a deeper analysis to see exactly which requirements you meet, which you don't, and how to position yourself.</p><button class="btn" data-analyze>✦ Analyse fit with Claude</button>`}
      </div>

      ${job.skills?.length ? `<div class="section"><h3>Skills listed</h3><div class="skills">${job.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div></div>` : ""}
      ${job.highlights?.qualifications?.length ? `<div class="section"><h3>Qualifications</h3><ul class="list">${job.highlights.qualifications.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}
      ${job.highlights?.responsibilities?.length ? `<div class="section"><h3>Responsibilities</h3><ul class="list">${job.highlights.responsibilities.map((q) => `<li>${esc(q)}</li>`).join("")}</ul></div>` : ""}
      <div class="section">
        <h3>Description</h3>
        <div class="desc${longDesc ? "" : " is-open"}" data-desc>${esc(desc)}</div>
        ${longDesc ? `<button class="btn btn-ghost btn-sm desc-toggle" data-desc-toggle>Show full description</button>` : ""}
      </div>
      <div class="section muted small">Sources: ${(job.sources || []).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher || s.sourceLabel)}</a>`).join(" · ")}</div>
    `;

    const root = $("#drawer-content");
    $("[data-close]", root).addEventListener("click", closeDrawer);
    $$("[data-go]", root).forEach((b) => b.addEventListener("click", () => { closeDrawer(); showView(b.dataset.go); }));
    const toggle = $("[data-apply-toggle]", root);
    if (toggle) toggle.addEventListener("click", () => { const l = $(".apply-menu-list", root); l.hidden = !l.hidden; });
    $("[data-status]", root).addEventListener("change", (e) => {
      const status = e.target.value;
      if (!status) removeTracker(job); else setTrackerStatus(job, status);
      renderResults();
      if (state.view === "tracker") renderTracker();
      renderDrawer(job, analysis, {});
    });
    $("[data-hide]", root).addEventListener("click", () => toggleHide(job));
    const notes = $("[data-notes]", root);
    if (notes) {
      const save = debounce(() => {
        if (!db.tracker[job.key]) return;
        db.tracker[job.key].notes = notes.value;
        db.tracker[job.key].updatedAt = new Date().toISOString();
        persist("tracker");
        $("[data-notes-state]", root).textContent = "Saved";
        setTimeout(() => { const s = $("[data-notes-state]", root); if (s) s.textContent = ""; }, 1500);
      }, 500);
      notes.addEventListener("input", save);
    }
    const analyzeBtn = $("[data-analyze]", root);
    if (analyzeBtn) analyzeBtn.addEventListener("click", () => runAnalysis(job));
    const dt = $("[data-desc-toggle]", root);
    if (dt) dt.addEventListener("click", () => { $("[data-desc]", root).classList.toggle("is-open"); dt.textContent = $("[data-desc]", root).classList.contains("is-open") ? "Show less" : "Show full description"; });
  }

  async function runAnalysis(job) {
    renderDrawer(job, null, { loadingAnalysis: true });
    try {
      const { analysis, usage } = await api("/api/analyze", { method: "POST", body: { profile: db.profile.profile, cvText: db.profile.cvText, job: jobForAi(job) } });
      recordUsage(usage, "analysis");
      db.analyses[scoreKey(job)] = analysis;
      prune(db.analyses, 150, (v) => v.analyzedAt || "");
      persist("analyses");
      job.hasAnalysis = true;
      if (state.drawerJobId === job.id) renderDrawer(job, analysis, {});
    } catch (err) {
      toast(err.message, "error", 7000);
      if (state.drawerJobId === job.id) renderDrawer(job, null, {});
    }
  }

  function analysisHtml(a) {
    const v = verdictOf(a.fitScore);
    return `<div class="analysis">
      <div class="analysis-head">${scoreRing({ score: a.fitScore, verdict: v })}<div><div class="verdict">${esc(a.verdict)}</div><div class="muted small">${esc(a.model || "")} · ${esc(timeAgo(a.analyzedAt) || "")}</div></div></div>
      <p>${esc(a.summary)}</p>
      ${a.requirementsMet?.length ? `<div class="section"><h3>You meet</h3><ul class="analysis-list met">${a.requirementsMet.map((r) => `<li>${esc(r.requirement)}<span class="sub">${esc(r.evidence)}</span></li>`).join("")}</ul></div>` : ""}
      ${a.requirementsMissing?.length ? `<div class="section"><h3>Gaps</h3><ul class="analysis-list missing">${a.requirementsMissing.map((r) => `<li class="${r.importance === "nice-to-have" ? "nice" : ""}">${esc(r.requirement)}<span class="imp ${r.importance === "must-have" ? "imp-must" : "imp-nice"}">${esc(r.importance)}</span><span class="sub">${esc(r.howToAddress)}</span></li>`).join("")}</ul></div>` : `<div class="section"><h3>Gaps</h3><p class="muted">No significant gaps found.</p></div>`}
      ${a.highlightInApplication?.length ? `<div class="section"><h3>Lead with</h3><ul class="analysis-list plain">${a.highlightInApplication.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      ${a.learnNext?.length ? `<div class="section"><h3>Worth learning</h3><ul class="analysis-list plain">${a.learnNext.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      ${a.redFlags?.length ? `<div class="section"><h3>Watch out</h3><ul class="analysis-list missing">${a.redFlags.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>` : ""}
      <div class="section"><button class="btn btn-ghost btn-sm" data-reanalyze>Re-run analysis</button></div>
    </div>`;
  }
  $("#drawer-content").addEventListener("click", (e) => {
    if (e.target.closest("[data-reanalyze]")) {
      const job = findJob(state.drawerJobId);
      if (job) runAnalysis(job);
    }
  });

  // ---------- Tracker ----------
  function renderTracker() {
    const board = $("#board");
    const labels = { saved: "Saved", applied: "Applied", interview: "Interview", offer: "Offer", rejected: "Rejected" };
    const items = Object.values(db.tracker).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    updateTrackerBadge();
    if (!items.length) {
      board.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><h2>Nothing tracked yet</h2><p>Star a job in search results to add it here, then move it along as you apply.</p></div>`;
      return;
    }
    const pv = db.profile?.version;
    board.innerHTML = STATUSES.map((s) => {
      const col = items.filter((i) => i.status === s);
      return `<div class="column" data-status="${s}">
        <div class="column-head"><span>${labels[s]}</span><span class="count">${col.length}</span></div>
        ${col.map((i) => {
          const j = i.job;
          const ai = pv ? db.scores[`${pv}:${j.key}`] : null;
          const last = i.history?.[i.history.length - 1];
          return `<div class="card" draggable="true" data-key="${esc(i.key)}" data-id="${esc(j.id)}">
            <div class="card-title">${esc(j.title)}</div>
            <div class="card-company">${esc(j.company)}</div>
            ${i.notes ? `<div class="card-notes">${esc(i.notes)}</div>` : ""}
            <div class="card-meta"><span>${esc(last ? `${labels[last.status]} ${timeAgo(last.at)}` : "")}</span>${ai ? `<span class="mini-score verdict-${ai.verdict}">${ai.score}</span>` : ""}</div>
          </div>`;
        }).join("")}
      </div>`;
    }).join("");

    let dragKey = null;
    $$(".card", board).forEach((card) => {
      card.addEventListener("dragstart", (e) => { dragKey = card.dataset.key; card.classList.add("is-dragging"); e.dataTransfer.effectAllowed = "move"; });
      card.addEventListener("dragend", () => card.classList.remove("is-dragging"));
      card.addEventListener("click", () => openDrawer(card.dataset.id));
    });
    $$(".column", board).forEach((col) => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("is-over"); });
      col.addEventListener("dragleave", () => col.classList.remove("is-over"));
      col.addEventListener("drop", (e) => {
        e.preventDefault(); col.classList.remove("is-over");
        const item = dragKey && db.tracker[dragKey];
        if (!item || item.status === col.dataset.status) return;
        const live = findJob(item.job.id) || item.job;
        setTrackerStatus(live, col.dataset.status);
        renderTracker();
      });
    });
  }

  // ---------- Profile ----------
  function renderProfile() {
    const box = $("#profile-content");
    const p = db.profile;
    const upload = `
      <div class="dropzone" id="dropzone">
        <input type="file" id="cv-file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" />
        <strong>${p ? "Drop a new CV to replace the current one" : "Drop your CV here or click to choose"}</strong>
        <span class="muted">PDF or Word (.docx). The file is read in your browser; only its text goes to Claude — about a cent of API credit.</span>
      </div>
      <details style="margin-top:10px"><summary class="small muted" style="cursor:pointer">Or paste the CV text instead</summary>
        <textarea id="cv-paste" placeholder="Paste the full text of your CV here…" style="margin-top:8px;min-height:140px"></textarea>
        <button class="btn btn-sm" id="cv-paste-btn" style="margin-top:6px">Build profile from text</button></details>
      <div id="upload-status" class="progress-note" style="margin-top:12px" hidden></div>`;

    if (!p) {
      box.innerHTML = `<div class="panel">${upload}${!hasAnthropicKey() ? `<div class="callout" style="margin-top:14px">You'll need an Anthropic API key in <button data-go="settings" class="btn btn-xs">Settings</button> before uploading.</div>` : ""}<p class="muted small" style="margin-top:14px">Privacy: the CV text is sent to Anthropic's API for analysis and kept in this browser only.</p></div>`;
      wireUpload();
      $$("[data-go]", box).forEach((b) => b.addEventListener("click", () => showView(b.dataset.go)));
      return;
    }
    const pr = p.profile;
    box.innerHTML = `
      <div class="profile-grid">
        <div>
          <div class="panel">
            <h2>${esc(pr.name || "Profile")} <span class="muted small" style="font-weight:400">${esc(p.fileName)} · ${esc(timeAgo(p.uploadedAt))}</span></h2>
            <p><strong>${esc(pr.headline)}</strong></p>
            <p>${esc(pr.summary)}</p>
            <dl class="kv">
              <dt>Seniority</dt><dd>${esc(pr.seniority)} · ${esc(pr.yearsExperience)} yrs</dd>
              <dt>Current title</dt><dd>${esc(pr.currentTitle || "—")}</dd>
              <dt>Industries</dt><dd>${esc(pr.industries.join(", ") || "—")}</dd>
              <dt>Languages</dt><dd>${esc(pr.languages.join(", ") || "—")}</dd>
            </dl>
            <div class="section"><h3>Skills</h3><div class="skills">${pr.skills.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div></div>
            <div class="section"><h3>Tools</h3><div class="skills">${pr.tools.map((s) => `<span class="tag">${esc(s)}</span>`).join("")}</div></div>
            <div class="section"><h3>Experience</h3>${pr.experience.map((e) => `<div class="exp-item"><div class="t">${esc(e.title)}</div><div class="c">${esc(e.company)}</div><div class="p">${esc(e.period)}</div></div>`).join("") || "<p class='muted'>—</p>"}</div>
            <div class="section"><h3>Education</h3>${pr.education.map((e) => `<div class="exp-item"><div class="t">${esc(e.degree)}</div><div class="c">${esc(e.institution)}${e.year ? ` · ${esc(e.year)}` : ""}</div></div>`).join("") || "<p class='muted'>—</p>"}</div>
          </div>
          <div class="panel">${upload}<div style="margin-top:12px"><button class="btn btn-danger btn-sm" id="remove-cv">Remove CV and profile</button></div></div>
        </div>
        <div>
          <div class="panel">
            <h2>Suggested searches <button class="btn btn-primary btn-sm" data-for-me>✦ Show jobs for me</button></h2>
            <div class="suggest-grid">${pr.suggestedSearches.map((s) => `<button class="suggest-card" data-q="${esc(s.query)}"><span class="q">${esc(s.query)}</span><span class="w">${esc(s.reason)}</span></button>`).join("")}</div>
          </div>
          <div class="panel"><h2>Roles you fit</h2><div class="skills">${pr.targetRoles.map((r) => `<span class="tag">${esc(r)}</span>`).join("")}</div></div>
          <div class="panel"><h2>Strengths to sell</h2><ul class="list">${pr.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
          <div class="panel"><h2>Development areas</h2><ul class="list">${pr.developmentAreas.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
        </div>
      </div>`;
    wireUpload();
    $$("[data-for-me]", box).forEach((b) => b.addEventListener("click", () => runSuggested()));
    $$("[data-q]", box).forEach((b) => b.addEventListener("click", () => { qInput.value = b.dataset.q; showView("search"); runSearch(); }));
    $("#remove-cv").addEventListener("click", () => {
      if (!confirm("Remove your CV and profile from this browser? Scores and analyses will be kept but no longer shown.")) return;
      db.profile = null;
      store.remove("profile");
      $("#for-me-btn").hidden = true;
      renderSidebar(); renderProfile();
      for (const j of state.results?.jobs || []) j.ai = null;
    });
  }

  function wireUpload() {
    const zone = $("#dropzone");
    const input = $("#cv-file");
    if (!zone) return;
    zone.addEventListener("click", () => input.click());
    zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("is-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("is-over"));
    zone.addEventListener("drop", (e) => { e.preventDefault(); zone.classList.remove("is-over"); if (e.dataTransfer.files[0]) uploadCv(e.dataTransfer.files[0]); });
    input.addEventListener("change", () => { if (input.files[0]) uploadCv(input.files[0]); });
    $("#cv-paste-btn").addEventListener("click", () => {
      const text = cleanText($("#cv-paste").value);
      if (text.length < 200) return toast("Paste the full CV text first (at least a few paragraphs).", "error");
      buildProfile(text, "pasted text");
    });
  }

  // ---------- Settings ----------
  function maskKey(k) { return k ? `••••${k.slice(-4)}` : ""; }

  function renderSettings() {
    const s = db.settings;
    const u = db.usage;
    const box = $("#settings-content");
    const srcRows = state.meta.sources.map((src) => {
      const desc = {
        jsearch: "Google Jobs aggregator — LinkedIn, Indeed, JobStreet, Glassdoor & company sites. Needs a RapidAPI key; ~200 searches/month free.",
        mycareersfuture: "Singapore government portal. No key needed. Uses the portal's unofficial API.",
        remotive: "Remote jobs worldwide, filtered to ones open to Asia. No key needed.",
        arbeitnow: "Mostly European board; only remote roles are kept. Off by default because of low relevance.",
      }[src.id] || "";
      return `<label class="switch-row"><span><span class="l">${esc(src.label)}</span><span class="s">${esc(desc)}</span></span><input type="checkbox" data-src="${src.id}" ${s.sources[src.id] ? "checked" : ""}></label>`;
    }).join("");
    const sk = state.meta.serverKeys || {};

    box.innerHTML = `
      <div class="settings-grid">
        <div>
          <div class="panel">
            <h2>API keys</h2>
            <p class="small muted">Keys are saved in this browser only and sent to the server just to make each request.</p>
            ${state.meta.passwordRequired ? `<div class="form-row">
              <label class="field-label">Site access password</label>
              <div class="key-row"><input type="password" id="k-password" value="${esc(s.appPassword)}" autocomplete="off"><button class="btn btn-sm" data-reveal="k-password">Show</button></div>
              <div class="hint">Ask whoever shared this site with you.</div>
            </div>` : ""}
            <div class="form-row">
              <label class="field-label">Anthropic API key</label>
              <div class="key-row"><input type="password" id="k-anthropic" placeholder="${s.anthropicApiKey ? "Leave blank to keep current key" : sk.anthropic ? "Optional — this site provides one" : "sk-ant-…"}" autocomplete="off"><button class="btn btn-sm" data-reveal="k-anthropic">Show</button></div>
              <div class="key-state">${s.anthropicApiKey ? `<span class="ok">✓ Saved</span> (${esc(maskKey(s.anthropicApiKey))}) <button class="btn btn-xs btn-ghost" data-clear="anthropicApiKey">remove</button>` : sk.anthropic ? `<span class="ok">✓ Provided by this site</span>` : `Not set. <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">Create one in the Anthropic Console ↗</a>`}</div>
              <div class="hint">Powers CV profile, match scores and gap analysis.</div>
            </div>
            <div class="form-row">
              <label class="field-label">RapidAPI key (for JSearch)</label>
              <div class="key-row"><input type="password" id="k-rapid" placeholder="${s.rapidApiKey ? "Leave blank to keep current key" : sk.rapidapi ? "Optional — this site provides one" : "Paste your RapidAPI key"}" autocomplete="off"><button class="btn btn-sm" data-reveal="k-rapid">Show</button></div>
              <div class="key-state">${s.rapidApiKey ? `<span class="ok">✓ Saved</span> (${esc(maskKey(s.rapidApiKey))})${state.jsearchQuota ? ` · quota ${state.jsearchQuota.remaining}/${state.jsearchQuota.limit} left this month` : ""} <button class="btn btn-xs btn-ghost" data-clear="rapidApiKey">remove</button>` : sk.rapidapi ? `<span class="ok">✓ Provided by this site</span>` : "Not set — JSearch is skipped until you add one."}</div>
              <details style="margin-top:8px"><summary class="small" style="cursor:pointer;color:var(--accent-strong);font-weight:600">How to get a free JSearch key (5 minutes)</summary>
                <ol class="steps small">
                  <li>Create a free account at <a href="https://rapidapi.com/auth/sign-up" target="_blank" rel="noopener">rapidapi.com ↗</a>.</li>
                  <li>Open the <a href="https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch/pricing" target="_blank" rel="noopener">JSearch pricing page ↗</a> and subscribe to the <strong>Basic (free)</strong> plan — no card needed.</li>
                  <li>Go to the JSearch <em>Endpoints</em> tab; the code sample on the right shows <code>x-rapidapi-key</code>. Copy that value.</li>
                  <li>Paste it above and click Save.</li>
                </ol></details>
            </div>
            <button class="btn btn-primary" id="save-keys">Save keys</button>
          </div>

          <div class="panel">
            <h2>Job sources</h2>
            ${srcRows}
            <div class="form-row" style="margin-top:14px">
              <label class="field-label">JSearch pages per search</label>
              <select id="jsearch-pages" class="select select-sm"><option value="1" ${s.jsearchPages === 1 ? "selected" : ""}>1 page · 10 jobs · 1 API call</option><option value="2" ${s.jsearchPages === 2 ? "selected" : ""}>2 pages · 20 jobs · 2 API calls</option><option value="3" ${s.jsearchPages === 3 ? "selected" : ""}>3 pages · 30 jobs · 3 API calls</option></select>
              <div class="hint">Each page spends one of your ~200 monthly calls. Results are cached in this browser for 6 hours so repeating a search is free.</div>
            </div>
            <div class="form-row">
              <label class="field-label">Results per source (keyless sources)</label>
              <input type="number" id="per-source" class="input-sm" min="5" max="50" value="${s.resultsPerSource}" style="width:90px">
            </div>
            <div class="form-row">
              <label class="field-label">Default location</label>
              <input id="default-loc" class="input-sm" value="${esc(s.defaultLocation)}" style="width:220px">
            </div>
            <button class="btn btn-primary" id="save-sources">Save</button>
            <button class="btn btn-ghost" id="clear-cache" title="Forget cached search results">Clear result cache</button>
          </div>

          <div class="panel">
            <h2>Start fresh</h2>
            <p class="small muted">Removes the CV, profile, tracker, hidden jobs, saved searches, scores and analyses from this browser. Your keys and settings are kept.</p>
            <button class="btn btn-danger" id="reset-all">Delete all my data</button>
          </div>
        </div>

        <div>
          <div class="panel">
            <h2>AI matching</h2>
            <label class="switch-row"><span><span class="l">Score results automatically</span><span class="s">Every new search result is scored against your CV as soon as it appears.</span></span><input type="checkbox" id="auto-score" ${s.autoScore ? "checked" : ""}></label>
            <div class="form-row" style="margin-top:12px">
              <label class="field-label">Model for bulk scoring</label>
              <select id="m-scoring" class="select select-sm">${modelOptions(s.models.scoring)}</select>
              <div class="hint">Runs on every result — a cheap, fast model keeps this to well under a cent per job.</div>
            </div>
            <div class="form-row">
              <label class="field-label">Model for CV profile & gap analysis</label>
              <select id="m-analysis" class="select select-sm">${modelOptions(s.models.analysis)}</select>
              <div class="hint">Runs once per CV and once per job you choose to analyse.</div>
            </div>
            <button class="btn btn-primary" id="save-ai">Save</button>
          </div>

          <div class="panel">
            <h2>Usage so far</h2>
            <div class="usage-grid">
              <div class="stat"><div class="n">$${u.estimatedUsd.toFixed(3)}</div><div class="l">Estimated spend</div></div>
              <div class="stat"><div class="n">${u.calls}</div><div class="l">API calls</div></div>
              <div class="stat"><div class="n">${Math.round(((u.inputTokens || 0) + (u.outputTokens || 0)) / 1000)}k</div><div class="l">Tokens</div></div>
            </div>
            <p class="muted small" style="margin-top:10px">${Object.entries(u.byPurpose || {}).map(([k, v]) => `${k}: ${v.calls} calls · $${v.usd.toFixed(3)}`).join(" · ") || "No AI calls yet."}</p>
            <p class="muted small">Estimates use list prices; check the Anthropic Console for exact billing.</p>
          </div>

          <div class="panel">
            <h2>Your data</h2>
            <p class="small">Everything — keys, CV profile, tracker, scores — is stored in this browser on this device. Clearing the browser's site data removes it, and it isn't shared with other devices. Back it up any time:</p>
            <button class="btn btn-sm" id="export-data">Download backup</button>
            <label class="btn btn-sm" style="margin-left:6px">Restore backup <input type="file" id="import-data" accept="application/json" hidden></label>
          </div>
        </div>
      </div>`;

    $$("[data-reveal]", box).forEach((b) => b.addEventListener("click", () => {
      const i = $(`#${b.dataset.reveal}`);
      i.type = i.type === "password" ? "text" : "password";
      b.textContent = i.type === "password" ? "Show" : "Hide";
    }));
    $$("[data-clear]", box).forEach((b) => b.addEventListener("click", () => { db.settings[b.dataset.clear] = ""; persist("settings"); renderSettings(); }));
    $("#save-keys").addEventListener("click", () => {
      const a = $("#k-anthropic").value.trim();
      const r = $("#k-rapid").value.trim();
      const pw = $("#k-password");
      if (a) db.settings.anthropicApiKey = a;
      if (r) db.settings.rapidApiKey = r;
      if (pw) db.settings.appPassword = pw.value.trim();
      if (!a && !r && !pw) return toast("Nothing to save — paste a key first.");
      persist("settings");
      toast("Keys saved");
      renderSettings();
    });
    $("#save-sources").addEventListener("click", () => {
      $$("[data-src]", box).forEach((i) => (db.settings.sources[i.dataset.src] = i.checked));
      db.settings.jsearchPages = Math.min(3, Math.max(1, Number($("#jsearch-pages").value) || 1));
      db.settings.resultsPerSource = Math.min(50, Math.max(5, Number($("#per-source").value) || 25));
      db.settings.defaultLocation = $("#default-loc").value.trim() || "Singapore";
      persist("settings");
      applyDefaultLocation();
      toast("Source settings saved");
      renderSettings();
    });
    $("#save-ai").addEventListener("click", () => {
      db.settings.autoScore = $("#auto-score").checked;
      db.settings.models = { scoring: $("#m-scoring").value, analysis: $("#m-analysis").value };
      persist("settings");
      toast("AI settings saved");
      renderSettings();
    });
    $("#clear-cache").addEventListener("click", async () => {
      store.remove("cache");
      try { await api("/api/cache/clear", { method: "POST" }); } catch { /* server cache is best-effort */ }
      toast("Cleared cached searches");
    });
    $("#reset-all").addEventListener("click", () => {
      if (!confirm("Delete your CV, profile, tracker, saved searches and all AI results from this browser? Keys are kept. This cannot be undone.")) return;
      for (const k of ["profile", "tracker", "hidden", "seen", "searches", "history", "scores", "analyses", "usage", "cache", "lastParams"]) store.remove(k);
      db.profile = null; db.tracker = {}; db.hidden = {}; db.seen = {}; db.searches = []; db.history = []; db.scores = {}; db.analyses = {}; db.usage = { ...ZERO_USAGE, byPurpose: {} };
      state.results = null;
      $("#for-me-btn").hidden = true;
      renderSidebar(); updateTrackerBadge(); renderSettings();
      toast("All data deleted. You're starting fresh.");
    });
    $("#export-data").addEventListener("click", () => {
      const dump = {};
      for (const k of ["settings", "profile", "tracker", "hidden", "seen", "searches", "history", "scores", "analyses", "usage"]) dump[k] = db[k];
      const blob = new Blob([JSON.stringify({ app: "job-seek", exportedAt: new Date().toISOString(), data: dump }, null, 1)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `job-seek-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    });
    $("#import-data").addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (parsed.app !== "job-seek" || !parsed.data) throw new Error("That file isn't a Job Seek backup.");
        if (!confirm("Restore this backup? It replaces the data currently in this browser.")) return;
        for (const [k, v] of Object.entries(parsed.data)) { db[k] = v; persist(k); }
        toast("Backup restored");
        location.reload();
      } catch (err) { toast(err.message, "error"); }
    });
  }

  function modelOptions(selected) {
    const models = [
      ["claude-haiku-4-5", "Claude Haiku 4.5 — fastest, cheapest"],
      ["claude-sonnet-5", "Claude Sonnet 5 — balanced"],
      ["claude-opus-5", "Claude Opus 5 — most capable, priciest"],
    ];
    return models.map(([id, label]) => `<option value="${id}" ${id === selected ? "selected" : ""}>${label}</option>`).join("");
  }

  init();
})();
