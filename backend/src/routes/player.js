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
    // Pi 5: HEVC hardware decode via V4L2 Request API → DRM PRIME buffers
    // gpu-next can zero-copy import DRM PRIME frames over Wayland
    "--hwdec=drmprime",
    "--vo=gpu-next",
    "--gpu-context=wayland",
    "--vd-lavc-threads=4",   // used as fallback if hwdec fails
    // Network / streaming buffer — reduce stutter on slow links
    "--cache=yes",
    "--cache-secs=30",
    "--demuxer-max-bytes=150M",
    "--demuxer-readahead-secs=20",
    `--title=${title || "StremioPI"}`,
    url,
  ];

  // Pass display env so MPV can open a window when launched from pm2 (no display by default)
  const uid = process.getuid ? process.getuid() : 1000;
  const mpvEnv = {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",   // Pi 5 Wayfire socket
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };

  mpvProcess = spawn("mpv", args, { detached: true, stdio: "ignore", env: mpvEnv });
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
