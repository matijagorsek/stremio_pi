/**
 * Shared MPV player service — used by both the HTTP route and the Telegram bot.
 * Manages a single mpv process; killing it before spawning a new one.
 */
import { spawn } from "child_process";

let mpvProcess = null;

function getMpvEnv() {
  const uid = process.getuid ? process.getuid() : 1000;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

export function launchMpv(url, title = "Electro") {
  if (!url || typeof url !== "string") throw new Error("Invalid url");

  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
  }

  console.log("[Electro] Launching MPV:", url.slice(0, 80));

  const args = [
    "--fullscreen",
    "--fs-screen=0",
    "--force-window=yes",
    "--no-terminal",
    "--osd-level=1",
    "--hwdec=drmprime",        // Pi 5 HEVC hardware decode via DRM PRIME
    "--vo=gpu-next",           // gpu-next imports DRM PRIME frames zero-copy
    "--gpu-context=wayland",
    "--vd-lavc-threads=4",     // fallback thread count if hwdec misses
    "--cache=yes",
    "--cache-secs=30",
    "--demuxer-max-bytes=150M",
    "--demuxer-readahead-secs=20",
    `--title=${title}`,
    url,
  ];

  mpvProcess = spawn("mpv", args, { detached: true, stdio: "ignore", env: getMpvEnv() });
  mpvProcess.unref();

  mpvProcess.on("exit", (code) => {
    console.log("[Electro] MPV exited with code", code);
    mpvProcess = null;
  });
  mpvProcess.on("error", (err) => {
    console.error("[Electro] MPV error:", err.message);
    mpvProcess = null;
  });
}

export function stopMpv() {
  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
    return true;
  }
  return false;
}

export function isMpvRunning() {
  return mpvProcess != null && !mpvProcess.killed;
}
