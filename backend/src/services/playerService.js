/**
 * Shared MPV player service — used by both the HTTP route and the Telegram bot.
 * Manages a single mpv process; killing it before spawning a new one.
 *
 * Exit codes:
 *   0  — quit by user (q key, stop command, etc.)
 *   4  — playback ended naturally (EOF) → file can be deleted
 */
import { spawn } from "child_process";

const WATCH_LATER_DIR = process.env.WATCH_LATER_DIR ||
  `${process.env.HOME || "/home/jarvis"}/stremio_pi/watch_later`;

let mpvProcess  = null;
let onExitCb    = null;

function getMpvEnv() {
  const uid = process.getuid ? process.getuid() : 1000;
  return {
    ...process.env,
    DISPLAY: process.env.DISPLAY || ":0",
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY || "wayland-0",
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || `/run/user/${uid}`,
  };
}

/**
 * Launch MPV.
 * @param {string}   url      — local file path or http URL
 * @param {string}   title    — window title
 * @param {Function} onExit   — called with (exitCode) when MPV exits
 */
export function launchMpv(url, title = "Electro", onExit = null) {
  if (!url || typeof url !== "string") throw new Error("Invalid url");

  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
    onExitCb   = null;
  }

  console.log("[Electro] Launching MPV:", String(url).slice(0, 80));

  onExitCb = onExit;

  const args = [
    "--fullscreen",
    "--fs-screen=0",
    "--force-window=yes",
    "--no-terminal",
    "--osd-level=1",
    // Software decode — jedino pouzdano na Pi 5 + Wayland
    "--hwdec=no",
    "--vo=gpu",
    "--gpu-context=wayland",
    "--vd-lavc-threads=4",
    // HDR → SDR tone mapping
    "--tone-mapping=hable",
    "--hdr-compute-peak=no",
    // Pamti poziciju — resume pri sljedećem pokretanju iste datoteke
    "--save-position-on-quit",
    `--watch-later-directory=${WATCH_LATER_DIR}`,
    // Network cache (za HTTP URL-ove)
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
    const cb = onExitCb;
    mpvProcess = null;
    onExitCb   = null;
    cb?.(code);
  });

  mpvProcess.on("error", (err) => {
    console.error("[Electro] MPV error:", err.message);
    const cb = onExitCb;
    mpvProcess = null;
    onExitCb   = null;
    cb?.(-1);
  });
}

export function stopMpv() {
  if (mpvProcess && !mpvProcess.killed) {
    try { mpvProcess.kill(); } catch {}
    mpvProcess = null;
    onExitCb   = null;
    return true;
  }
  return false;
}

export function isMpvRunning() {
  return mpvProcess != null && !mpvProcess.killed;
}
