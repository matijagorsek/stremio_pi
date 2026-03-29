/**
 * YouTube route — search, history, recommendations via yt-dlp
 * GET /youtube/search?q=query&limit=15
 * GET /youtube/feed                      → { history, recommended }
 * GET /youtube/cookies                   → { hascookies: bool }
 */
import { Router } from "express";
import { spawn }  from "child_process";
import fs         from "fs";
import path       from "path";
import os         from "os";

const router = Router();

const COOKIES_PATH = process.env.YT_COOKIES_PATH ||
  path.join(os.homedir(), "stremio_pi", "yt-cookies.txt");

function hasCookies() {
  return fs.existsSync(COOKIES_PATH);
}

function ytDlp(args, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const allArgs = hasCookies() ? ["--cookies", COOKIES_PATH, ...args] : args;
    const proc = spawn("yt-dlp", allArgs, { env: process.env });
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("close", code => {
      if (code !== 0) reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", e => reject(new Error(`yt-dlp not found: ${e.message}`)));
    const timer = setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("yt-dlp timeout")); }, timeoutMs);
    proc.on("close", () => clearTimeout(timer));
  });
}

function parseEntry(line) {
  try {
    const v = JSON.parse(line);
    if (!v || !v.id) return null;
    return {
      id:        v.id,
      title:     v.title     || v.fulltitle || "Video",
      channel:   v.uploader  || v.channel   || v.channel_id || "",
      duration:  v.duration  || null,
      thumbnail: v.thumbnail || (v.thumbnails?.length ? v.thumbnails[v.thumbnails.length - 1]?.url : null) || null,
      url:       `https://www.youtube.com/watch?v=${v.id}`,
    };
  } catch { return null; }
}

function parseLines(raw) {
  return raw.split("\n").map(l => l.trim()).filter(Boolean).map(parseEntry).filter(Boolean);
}

// GET /youtube/cookies
router.get("/cookies", (_req, res) => {
  res.json({ hascookies: hasCookies(), path: COOKIES_PATH });
});

// GET /youtube/search?q=...&limit=15
router.get("/search", async (req, res) => {
  const q     = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 15, 30);
  if (!q) return res.status(400).json({ error: "q is required" });

  try {
    const raw = await ytDlp([
      `ytsearch${limit}:${q}`,
      "--dump-json", "--no-playlist", "--flat-playlist", "--no-warnings", "--skip-download",
    ]);
    res.json({ results: parseLines(raw) });
  } catch (err) {
    console.error("[YouTube] search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /youtube/feed  →  { history: [], recommended: [] }
router.get("/feed", async (req, res) => {
  if (!hasCookies()) {
    return res.json({ history: [], recommended: [], needsCookies: true });
  }

  const flatArgs = ["--dump-json", "--flat-playlist", "--no-warnings", "--skip-download", "--playlist-end", "30"];

  const [historyResult, recommendedResult] = await Promise.allSettled([
    ytDlp(["https://www.youtube.com/feed/history", ...flatArgs], 30000),
    ytDlp(["https://www.youtube.com/feed/recommended", ...flatArgs], 30000),
  ]);

  res.json({
    history:     historyResult.status     === "fulfilled" ? parseLines(historyResult.value)     : [],
    recommended: recommendedResult.status === "fulfilled" ? parseLines(recommendedResult.value) : [],
  });
});

export default router;
