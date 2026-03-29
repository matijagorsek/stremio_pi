/**
 * YouTube route — search and resolve via yt-dlp
 * GET /youtube/search?q=query&limit=15   → [{ id, title, channel, duration, thumbnail, url }]
 * GET /youtube/resolve?url=URL           → { url, title } (best direct stream URL for MPV)
 */
import { Router } from "express";
import { spawn } from "child_process";

const router = Router();

function ytDlp(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { env: process.env });
    let out = "";
    let err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("close", code => {
      if (code !== 0) reject(new Error(err.trim() || `yt-dlp exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", e => reject(new Error(`yt-dlp not found: ${e.message}`)));
    // Timeout: 20s
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("yt-dlp timeout")); }, 20000);
  });
}

// Parse one JSON line from yt-dlp --dump-json output
function parseEntry(line) {
  try {
    const v = JSON.parse(line);
    if (!v || !v.id) return null;
    return {
      id:        v.id,
      title:     v.title     || v.fulltitle || "Video",
      channel:   v.uploader  || v.channel   || "",
      duration:  v.duration  || null,
      thumbnail: v.thumbnail || (v.thumbnails && v.thumbnails[v.thumbnails.length - 1]?.url) || null,
      url:       `https://www.youtube.com/watch?v=${v.id}`,
    };
  } catch { return null; }
}

// GET /youtube/search?q=...&limit=15
router.get("/search", async (req, res) => {
  const q     = String(req.query.q || "").trim();
  const limit = Math.min(parseInt(req.query.limit) || 15, 30);

  if (!q) return res.status(400).json({ error: "q is required" });

  try {
    const raw = await ytDlp([
      `ytsearch${limit}:${q}`,
      "--dump-json",
      "--no-playlist",
      "--flat-playlist",
      "--no-warnings",
      "--skip-download",
    ]);

    const results = raw.split("\n")
      .map(l => l.trim())
      .filter(Boolean)
      .map(parseEntry)
      .filter(Boolean);

    res.json({ results });
  } catch (err) {
    console.error("[YouTube] search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
