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
    // Software decode — jedino što pouzdano prikazuje sliku na Pi 5 + Wayland
    "--hwdec=no",
    "--vo=gpu",
    "--gpu-context=wayland",
    "--vd-lavc-threads=4",
    // HDR → SDR tone mapping (za HDR streamove koji bi inače bili isprani)
    "--tone-mapping=hable",
    "--hdr-compute-peak=no",
    // Network buffer — manje zastajkivanja
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
