// Local runner: serves the UI from ./public and the API on one port, then
// opens the browser. Run with `npm start` or the Start Job Seek launcher.
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { app, finalize, PUBLIC_DIR } from "./app.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const PREFERRED_PORT = Number(process.env.PORT) || 4747;

app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

// One-time import of data saved by the earlier, file-based version of the app
// (data/settings.json, data/profile.json). Local only — never part of the
// hosted API. The browser stores what it gets and this folder is then ignored.
app.get("/api/legacy", (req, res) => {
  const dataDir = path.resolve(here, "..", "data");
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dataDir, name), "utf8")); } catch { return null; }
  };
  const settings = read("settings.json");
  const profile = read("profile.json");
  if (!settings && !profile) return res.json({ found: false });
  res.json({ found: true, settings, profile });
});

finalize();

function listen(port, attempt = 0) {
  const server = app.listen(port, "127.0.0.1", () => {
    const url = `http://localhost:${port}`;
    console.log(`\n  Job Seek is running at ${url}\n  Press Ctrl+C to stop.\n`);
    if (!process.argv.includes("--no-open")) {
      const opener = { darwin: `open ${url}`, win32: `start "" ${url}`, linux: `xdg-open ${url}` }[process.platform];
      if (opener) exec(opener);
    }
  });
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && attempt < 10) {
      console.log(`Port ${port} is busy, trying ${port + 1}…`);
      listen(port + 1, attempt + 1);
    } else {
      console.error(err);
      process.exit(1);
    }
  });
}

listen(PREFERRED_PORT);
