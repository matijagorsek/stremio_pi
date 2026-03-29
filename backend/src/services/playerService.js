/**
 * Shared MPV player service.
 * Exit codes: 0 = user quit, 4 = natural end (EOF)
 *
 * IPC socket at /tmp/mpv-electro.sock enables pause/resume/progress queries.
 */
import { spawn } from "child_process";
import net from "net";

const IPC_SOCKET    = "/tmp/mpv-electro.sock";
const WATCH_LATER_DIR = process.env.WATCH_LATER_DIR ||
  `${process.env.HOME || "/home/jarvis"}/stremio_pi/watch_later`;

let mpvProcess = null;
let onExitCb   = null;

function getMpvEnv() {
  const uid = process.getuid ? process.getuid() : 1000;
  return {
    ...process.env,
    DISPLAY:          process.env.DISPLAY          || ":0",
    WAYLAND_DISPLAY:  process.env.WAYLAND_DISPLAY  || "wayland-0",
    XDG_RUNTIME_DIR:  process.env.XDG_RUNTIME_DIR  || `/run/user/${uid}`,
  };
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

/** Send a single command to MPV via IPC socket. Returns response data or null. */
export function mpvSend(command) {
  return new Promise((resolve) => {
    const sock = net.createConnection(IPC_SOCKET);
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); resolve(null); }, 2000);

    sock.on("connect", () => sock.write(JSON.stringify({ command }) + "\n"));
    sock.on("data", (chunk) => {
      buf += chunk.toString();
      const line = buf.split("\n").find((l) => l.trim());
      if (!line) return;
      clearTimeout(timer);
      sock.destroy();
      try { resolve(JSON.parse(line).data ?? null); }
      catch { resolve(null); }
    });
    sock.on("error", () => { clearTimeout(timer); resolve(null); });
  });
}

/** Toggle pause. Returns new paused state (true = paused, false = playing). */
export async function pauseMpv() {
  await mpvSend(["cycle", "pause"]);
  return mpvSend(["get_property", "pause"]);
}

/** Get current playback position and duration in seconds. */
export async function getMpvProgress() {
  const [position, duration, paused] = await Promise.all([
    mpvSend(["get_property", "playback-time"]),
    mpvSend(["get_property", "duration"]),
    mpvSend(["get_property", "pause"]),
  ]);
  return { position, duration, paused };
}

// ─── Launch / Stop ────────────────────────────────────────────────────────────

/**
 * @param {string}   url       — local file path or http URL
 * @param {string}   title
 * @param {Function} onExit    — called with exit code when MPV exits
 * @param {string[]} subFiles  — optional subtitle URLs/paths for MPV --sub-file
 */
export function launchMpv(url, title = "Electro", onExit = null, subFiles = []) {
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
    "--hwdec=no",
    "--vo=gpu",
    "--gpu-context=wayland",
    "--vd-lavc-threads=4",
    "--tone-mapping=hable",
    "--hdr-compute-peak=no",
    "--save-position-on-quit",
    `--watch-later-directory=${WATCH_LATER_DIR}`,
    "--cache=yes",
    "--cache-secs=30",
    "--demuxer-max-bytes=150M",
    "--demuxer-readahead-secs=20",
    `--input-ipc-server=${IPC_SOCKET}`,
    `--title=${title}`,
    ...subFiles.map((f) => `--sub-file=${f}`),
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
