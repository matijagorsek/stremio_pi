/**
 * StremioPI — MPV Player route
 * POST /player/launch  { url, title? } → spawns mpv fullscreen
 * POST /player/stop                    → kills mpv
 * GET  /player/status                  → { running: bool }
 */
import { Router } from "express";
import { launchMpv, stopMpv, isMpvRunning } from "../services/playerService.js";

const router = Router();

router.post("/launch", (req, res) => {
  const { url, title } = req.body || {};
  if (!url || typeof url !== "string" || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url — must be http/https" });
  }
  try {
    launchMpv(url, title || "StremioPI");
    res.json({ ok: true, message: "MPV launched" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/stop", (_req, res) => {
  const stopped = stopMpv();
  res.json({ ok: true, message: stopped ? "MPV stopped" : "No MPV running" });
});

router.get("/status", (_req, res) => {
  res.json({ running: isMpvRunning() });
});

export default router;
