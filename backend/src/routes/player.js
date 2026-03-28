/**
 * StremioPI — MPV Player launcher
 * POST /player/launch  { url, title? } → spawns mpv fullscreen
 * POST /player/stop                    → kills mpv
 * GET  /player/status                  → { running: bool }
 */
import { Router } from "express";
import { spawn } from "child_process";

const router = Router();
let mpvProcess = null;

router.post("/launch", (req, res) => {
  const { url, title } = req.body || {};
  if (!url || typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url — must be http/https" });
  }

  // Kill existing MPV if running
  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
  }

  console.log("[StremioPI] Launching MPV:", url.slice(0, 80));

  const args = [
    "--fullscreen",
    "--fs-screen=0",
    "--force-window=yes",
    "--no-terminal",
    "--osd-level=1",
    `--title=${title || "StremioPI"}`,
    url,
  ];

  mpvProcess = spawn("mpv", args, { detached: true, stdio: "ignore" });
  mpvProcess.unref();

  mpvProcess.on("exit", (code) => {
    console.log("[StremioPI] MPV exited with code", code);
    mpvProcess = null;
  });

  mpvProcess.on("error", (err) => {
    console.error("[StremioPI] MPV error:", err.message);
    mpvProcess = null;
  });

  res.json({ ok: true, message: "MPV launched" });
});

router.post("/stop", (_req, res) => {
  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
    res.json({ ok: true, message: "MPV stopped" });
  } else {
    res.json({ ok: true, message: "No MPV running" });
  }
});

router.get("/status", (_req, res) => {
  const running = mpvProcess != null && !mpvProcess.killed;
  res.json({ running });
});

export default router;
