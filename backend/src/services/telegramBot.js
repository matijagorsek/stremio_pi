/**
 * Electro — Telegram bot za filmove, serije i YouTube na Raspberry Pi 5.
 *
 * Flow za filmove/serije:
 *   1. Traži → nudi top 5 streamova
 *   2. Korisnik odabire broj → počinje preuzimanje s progress barom
 *   3. Nakon preuzimanja → MPV reproducira lokalnu datoteku
 *   4. MPV exit 4 (kraj filma) → datoteka se briše
 *   5. MPV exit 0 (korisnik zaustavio) → datoteka ostaje, pozicija pamti se
 *   6. Isti film drugi put → nudi nastavak ili iznova
 *
 * Komande: pusti <film> | serija <naziv> | youtube <url|naziv> | stop | 1–5
 */

import TelegramBot from "node-telegram-bot-api";
import { execFile, execFileSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readdirSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { getEnabledAddons } from "./addonStore.js";
import { getAddonSearch, getAddonStreams, getAddonMeta, getAddonSubtitles } from "./addonClient.js";
import { launchMpv, stopMpv, pauseMpv, getMpvProgress, isMpvRunning } from "./playerService.js";
import { DOWNLOADS_DIR, safeFilename, downloadFile } from "./downloadService.js";

const TOKEN    = process.env.ELECTRO_BOT_TOKEN;
const OWNER_ID = process.env.ELECTRO_OWNER_ID ? Number(process.env.ELECTRO_OWNER_ID) : null;
const ALLOWED  = new Set(
  (process.env.TELEGRAM_ALLOWED_CHAT_IDS || '').split(',').map(Number).filter(Boolean)
);

if (!TOKEN) {
  console.warn("[Electro] ELECTRO_BOT_TOKEN nije postavljen — bot se ne pokreće.");
}

// ─── State maps ───────────────────────────────────────────────────────────────
/** chatId → { streams, title, streamId, posterUrl, timer } */
const pendingSelection = new Map();

/** chatId → { controller, filePath, title } — active download */
const activeDownloads = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(t) {
  return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function progressBar(pct) {
  const filled = Math.min(10, Math.round((pct || 0) / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

function fmtBytes(b) {
  if (b >= 1073741824) return (b / 1073741824).toFixed(1) + " GB";
  if (b >= 1048576)    return Math.round(b / 1048576) + " MB";
  return Math.round(b / 1024) + " KB";
}

function fmtTime(secs) {
  if (!secs || isNaN(secs)) return "--:--";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Fetch best subtitle (Croatian first, then English) for given type/id */
async function fetchSubtitle(addons, type, id) {
  try {
    const subs = await getAddonSubtitles(addons, type, id);
    if (!subs || subs.length === 0) return null;
    const pref = ["hrv", "cro", "hr", "eng", "en"];
    for (const lang of pref) {
      const sub = subs.find((s) => s.lang?.toLowerCase().startsWith(lang));
      if (sub?.url) return sub.url;
    }
    return subs[0]?.url || null;
  } catch {
    return null;
  }
}

/** Croatian + English number words → 1-5 */
function parseChoice(text) {
  const t = text.trim().toLowerCase();
  const words = {
    jedan: 1, jedna: 1, one: 1, "1": 1,
    dva: 2, dvije: 2, two: 2, "2": 2,
    tri: 3, three: 3, "3": 3,
    četiri: 4, cetiri: 4, four: 4, "4": 4,
    pet: 5, five: 5, "5": 5,
  };
  if (words[t] !== undefined) return words[t];
  const n = parseInt(t, 10);
  return n >= 1 && n <= 5 ? n : null;
}

/**
 * Torrentio+RD puts codec info in `title` and `behaviorHints.filename`, NOT in `name`.
 * name = "[RD+] Torrentio\n1080p"
 * title = "The Dark Knight 1080p BluRay x264 - 1.7GB"
 * behaviorHints.filename = "Batman.The.Dark.Knight.2008.1080p.BluRay.x264.YIFY.mp4"
 */
function streamText(s) {
  return [
    s.name || "",
    s.title || "",
    s.behaviorHints?.filename || "",
    s.behaviorHints?.bingeGroup || "",
  ].join(" ").toLowerCase();
}

/** Quality + codec label, e.g. "1080p x264" */
function qualityLabel(s) {
  const n = streamText(s);
  const res  = n.includes("4k") || n.includes("2160p") ? "4K"
             : n.includes("1080p") ? "1080p"
             : n.includes("720p")  ? "720p"
             : n.includes("480p")  ? "480p"
             : "?";
  const codec = n.includes("hevc") || n.includes("x265") || n.includes("h265") ? " HEVC"
              : n.includes("x264") || n.includes("h264") || n.includes("avc")   ? " x264"
              : "";
  return res + codec;
}

/** Display label from title (torrent name) — more informative than name */
function streamDisplayName(s) {
  // title has full torrent info, strip the first line (movie title) if too long
  const t = (s.title || s.name || "Stream").split("\n")[0].trim();
  return t.slice(0, 55);
}

/** Sort: prefer x264 1080p (confirmed working on Pi 5), then 720p, avoid 4K/HDR/HEVC */
function sortStreams(streams) {
  const score = (s) => {
    const n = streamText(s);
    const is4k   = n.includes("4k") || n.includes("2160p");
    const is1080 = n.includes("1080p");
    const is720  = n.includes("720p");
    const is480  = n.includes("480p");
    const isHevc = n.includes("hevc") || n.includes("x265") || n.includes("h265");
    const isHdr  = n.includes("hdr") || n.includes("dolby") || n.includes(" dv");
    if (is4k || isHdr)    return 10; // skip — Pi 5 can't handle
    if (is1080 && !isHevc) return 0; // x264 1080p — best confirmed
    if (is720  && !isHevc) return 1; // x264 720p
    if (is1080 && isHevc)  return 2; // HEVC 1080p — maybe works
    if (is720  && isHevc)  return 3; // HEVC 720p
    if (is480)             return 5;
    return 4;
  };
  return [...streams].sort((a, b) => score(a) - score(b));
}

/** Find downloaded file for a given stream id */
function findDownload(streamId) {
  try {
    const files = readdirSync(DOWNLOADS_DIR);
    const match = files.find((f) => f.endsWith(`__${streamId}.mp4`));
    return match ? join(DOWNLOADS_DIR, match) : null;
  } catch {
    return null;
  }
}

// ─── Telegram message helpers ─────────────────────────────────────────────────

async function editCaption(bot, chatId, msgId, text, isPhoto) {
  if (!msgId) return;
  try {
    if (isPhoto) {
      await bot.editMessageCaption(text, { chat_id: chatId, message_id: msgId, parse_mode: "HTML" });
    } else {
      await bot.editMessageText(text, { chat_id: chatId, message_id: msgId, parse_mode: "HTML" });
    }
  } catch {}
}

/** Send poster image (if url provided) or text message. Returns { msgId, isPhoto } */
async function sendProgressMsg(bot, chatId, posterUrl, caption) {
  try {
    if (posterUrl) {
      const sent = await bot.sendPhoto(chatId, posterUrl, { caption, parse_mode: "HTML" });
      return { msgId: sent.message_id, isPhoto: true };
    }
  } catch {}
  // Fallback: send as text
  const sent = await bot.sendMessage(chatId, caption, { parse_mode: "HTML" });
  return { msgId: sent.message_id, isPhoto: false };
}

// ─── Download + Play flow (progressive) ──────────────────────────────────────
// Skida u pozadini dok MPV reproducira — kao streaming service.
// MPV se pokreće čim se skupi dovoljno buffer-a (100 MB), ostatak se skida paralelno.

/** Bytes buffered before starting playback (100 MB — ~30-60s video) */
const BUFFER_BYTES = 100 * 1024 * 1024;

async function downloadAndPlay(bot, chatId, stream, title, streamId, posterUrl, subFiles = []) {
  const filename = safeFilename(title, streamId);
  const destPath = join(DOWNLOADS_DIR, filename);
  const controller = new AbortController();

  activeDownloads.set(chatId, { controller, filePath: destPath, title });

  // 1. Pošalji inicijalnu progress poruku s posterom
  const { msgId, isPhoto } = await sendProgressMsg(bot, chatId, posterUrl,
    `📡 <b>${esc(title)}</b>\n\n${progressBar(0)} Buffering…\nPričekaj trenutak…`
  );

  let mpvLaunched   = false;
  let downloadDone  = false;
  let lastEditTime  = 0;

  // Što napraviti kad MPV izađe
  const onMpvExit = (exitCode) => {
    if (exitCode === 4) {
      // Film završio prirodno → cancel download ako još ide, obriši datoteku
      controller.abort();
      setTimeout(() => { try { unlinkSync(destPath); } catch {} }, 1000);
      bot.sendMessage(chatId,
        `✅ <b>${esc(title)}</b> — kraj filma! Datoteka obrisana.`,
        { parse_mode: "HTML" }
      ).catch(() => {});
    } else if (exitCode === 0) {
      // Korisnik zaustavio → datoteka ostaje, pozicija pamti se automatski
      // Nastavi download u pozadini (koristi se za resume)
      if (!downloadDone) {
        bot.sendMessage(chatId,
          `⏸ <b>${esc(title)}</b> — pauzirano.\nPreuzimanje nastavlja u pozadini za brži resume.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      } else {
        bot.sendMessage(chatId,
          `⏸ <b>${esc(title)}</b> — pauzirano. Resume kad budeš spreman.`,
          { parse_mode: "HTML" }
        ).catch(() => {});
      }
    }
  };

  // 2. Počni skidanje i prati napredak
  const onProgress = (dl, total) => {
    // Pokreni MPV čim imamo dovoljno buffera (ili odmah ako je datoteka mala)
    const bufferThreshold = total > 0 && total < BUFFER_BYTES * 2
      ? Math.round(total * 0.3)   // za male datoteke: čekaj 30%
      : BUFFER_BYTES;

    if (!mpvLaunched && dl >= bufferThreshold) {
      mpvLaunched = true;
      console.log(`[Electro] Buffer dostignut (${fmtBytes(dl)}) — pokrećem MPV`);
      launchMpv(destPath, title, onMpvExit, subFiles);
      editCaption(bot, chatId, msgId,
        `▶️ <b>${esc(title)}</b>\n\n${progressBar(total > 0 ? Math.round(dl/total*100) : 10)} Reproducira se!\n${fmtBytes(dl)} / ${total > 0 ? fmtBytes(total) : "?"} — skida se u pozadini`,
        isPhoto
      );
      return;
    }

    // Throttle Telegram updates
    const now = Date.now();
    if (now - lastEditTime < 4000) return;
    lastEditTime = now;

    const pct    = total > 0 ? Math.round(dl / total * 100) : null;
    const dlStr  = fmtBytes(dl) + (total > 0 ? ` / ${fmtBytes(total)}` : "");
    const bar    = progressBar(pct ?? 50);

    if (mpvLaunched) {
      // Reproducira se + skida u pozadini
      editCaption(bot, chatId, msgId,
        `▶️ <b>${esc(title)}</b>\n\n${bar} ${pct != null ? pct + "%" : "…"}\n${dlStr} — pozadina`,
        isPhoto
      );
    } else {
      // Još buffering
      editCaption(bot, chatId, msgId,
        `📡 <b>${esc(title)}</b>\n\n${bar} ${pct != null ? pct + "%" : "…"}\n${dlStr}\nBuffering…`,
        isPhoto
      );
    }
  };

  try {
    await downloadFile(stream.url, destPath, { signal: controller.signal, onProgress });
    downloadDone = true;
    activeDownloads.delete(chatId);
    console.log(`[Electro] Preuzimanje gotovo: ${destPath}`);

    if (!mpvLaunched) {
      // Mala datoteka — pokreni MPV sad
      launchMpv(destPath, title, onMpvExit, subFiles);
      await editCaption(bot, chatId, msgId, `▶️ <b>${esc(title)}</b>\n\nReproducira se! 🎬`, isPhoto);
    } else {
      // Obavijesti da je download gotov
      await editCaption(bot, chatId, msgId,
        `▶️ <b>${esc(title)}</b>\n\n${progressBar(100)} 100% — preuzeto!\nReproducira se 🎬`,
        isPhoto
      );
    }
  } catch (err) {
    activeDownloads.delete(chatId);
    // Ne prikazuj "otkazano" grešku ako je MPV već pokrenut (normalan kraj filma)
    if (!mpvLaunched || !err.message.includes("otkazano")) {
      const msg = err.message.includes("otkazano")
        ? `⏹ <b>Preuzimanje otkazano.</b>`
        : `❌ Greška pri preuzimanju:\n${esc(err.message)}`;
      await editCaption(bot, chatId, msgId, msg, isPhoto);
    }
  }
}

// ─── Core search + stream flow ────────────────────────────────────────────────

async function playFlow(bot, chatId, query, type) {
  const addons = getEnabledAddons();
  if (addons.length === 0) {
    return bot.sendMessage(chatId, "❌ Nema dodanih addona.", { parse_mode: "HTML" });
  }

  await bot.sendMessage(chatId, `🔍 Tražim <b>${esc(query)}</b>…`, { parse_mode: "HTML" });

  const results = await getAddonSearch(addons, type, query);
  if (!results || results.length === 0) {
    return bot.sendMessage(chatId, `❌ Ništa pronađeno za <b>${esc(query)}</b>.`, { parse_mode: "HTML" });
  }

  const item  = results[0];
  const label = item.title || item.name || query;
  const posterUrl = item.poster || null;
  console.log(`[Electro] Pronađeno: ${label} (${item.id})`);

  await bot.sendMessage(chatId, `🎬 <b>${esc(label)}</b>\n⏳ Dohvaćam streamove…`, { parse_mode: "HTML" });

  // Resolve IMDB id for movies (Torrentio+RD needs it)
  let streamId = item.id;
  if (type === "movie") {
    const meta = await getAddonMeta(addons, "movie", item.id).catch(() => null);
    if (meta && meta.imdbId) streamId = meta.imdbId;
  }

  const streams = await getAddonStreams(addons, type, streamId);
  if (!streams || streams.length === 0) {
    return bot.sendMessage(chatId, `❌ Nema streamova za <b>${esc(label)}</b>.`, { parse_mode: "HTML" });
  }

  const sorted = sortStreams(streams);

  // If only one stream → skip selection
  if (sorted.length === 1) {
    return startDownloadFlow(bot, chatId, sorted[0], label, streamId, posterUrl);
  }

  const top5 = sorted.slice(0, 5);
  const lines = top5.map((s, i) => {
    const q    = qualityLabel(s);
    const name = streamDisplayName(s);
    return `${i + 1}. <b>${q}</b> — ${esc(name)}`;
  });

  clearPending(chatId);

  const timer = setTimeout(() => {
    pendingSelection.delete(chatId);
    bot.sendMessage(chatId, "⏱ Isteklo vrijeme odabira.").catch(() => {});
  }, 90_000);

  // Tag each stream with content type so subtitle fetch knows movie vs series
  top5.forEach((s) => { s._type = type; });
  pendingSelection.set(chatId, { streams: top5, title: label, streamId, posterUrl, timer });

  await bot.sendMessage(chatId,
    `🎬 <b>${esc(label)}</b>\n\nOdaberi stream (1–${top5.length}):\n\n${lines.join("\n")}`,
    { parse_mode: "HTML" }
  );
}

async function startDownloadFlow(bot, chatId, stream, title, streamId, posterUrl) {
  // Check if already downloaded
  const existing = findDownload(streamId);
  if (existing && existsSync(existing)) {
    clearPending(chatId);
    const timer = setTimeout(() => {
      pendingSelection.delete(chatId);
    }, 30_000);
    pendingSelection.set(chatId, {
      _resumeChoice: true,
      filePath: existing,
      title,
      streamId,
      stream,
      posterUrl,
      timer,
    });
    return bot.sendMessage(chatId,
      `📂 <b>${esc(title)}</b> je već preuzet!\n\n1. Nastavi od zadnje pozicije\n2. Preuzmi iznova`,
      { parse_mode: "HTML" }
    );
  }

  // Fetch subtitles in background (Croatian first, then English)
  const addons = getEnabledAddons();
  const type   = stream._type || "movie";
  const subUrl = await fetchSubtitle(addons, type, streamId).catch(() => null);
  const subFiles = subUrl ? [subUrl] : [];
  if (subUrl) console.log(`[Electro] Titlovi: ${subUrl.slice(0, 80)}`);

  await downloadAndPlay(bot, chatId, stream, title, streamId, posterUrl, subFiles);
}

function clearPending(chatId) {
  const p = pendingSelection.get(chatId);
  if (p) { clearTimeout(p.timer); pendingSelection.delete(chatId); }
}

// ─── Whisper transcription ────────────────────────────────────────────────────

function transcribeAudio(wavPath) {
  return new Promise((resolve, reject) => {
    const pyScript =
      `import sys\n` +
      `from faster_whisper import WhisperModel\n` +
      `m = WhisperModel("base", device="cpu", compute_type="int8")\n` +
      `segs, _ = m.transcribe(sys.argv[1], beam_size=5)\n` +
      `print(" ".join(s.text for s in segs).strip())\n`;

    const pyPath = join(tmpdir(), `electro_whisper_${Date.now()}.py`);
    writeFileSync(pyPath, pyScript);

    execFile("python3", [pyPath, wavPath], { timeout: 30000 }, (err, stdout, stderr) => {
      try { unlinkSync(pyPath); } catch {}
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout.trim());
    });
  });
}

async function handleVoice(bot, msg) {
  const chatId = msg.chat.id;
  const stamp  = Date.now();
  const oggPath = join(tmpdir(), `electro_${stamp}.ogg`);
  const wavPath = join(tmpdir(), `electro_${stamp}.wav`);

  try {
    await bot.sendMessage(chatId, "🎙️ Slušam…");

    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    writeFileSync(oggPath, Buffer.from(await res.arrayBuffer()));

    execFileSync("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath], { stdio: "pipe" });

    const text = await transcribeAudio(wavPath);
    console.log(`[Electro] 🎙️ Transkripcija: "${text}"`);

    if (!text) {
      await bot.sendMessage(chatId, "🤔 Nisam razumio — pokušaj ponovo.");
      return;
    }

    await bot.sendMessage(chatId, `🎙️ <i>${esc(text)}</i>`, { parse_mode: "HTML" });
    await handleText(bot, chatId, text);

  } catch (err) {
    console.error("[Electro] Voice error:", err.message);
    await bot.sendMessage(chatId, `❌ Greška: ${esc(err.message)}`);
  } finally {
    for (const p of [oggPath, wavPath]) {
      try { if (existsSync(p)) unlinkSync(p); } catch {}
    }
  }
}

// ─── YouTube via yt-dlp ───────────────────────────────────────────────────────

function ytdlpGetUrl(query) {
  return new Promise((resolve, reject) => {
    const isUrl = /^https?:\/\//i.test(query);
    const target = isUrl ? query : `ytsearch1:${query}`;
    execFile("yt-dlp", [
      "-f", "bestvideo[height<=1080][ext=mp4]+bestaudio[ext=m4a]/best[height<=1080][ext=mp4]/best[height<=1080]",
      "--get-url",
      "--no-playlist",
      target,
    ], { timeout: 20000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      const urls = stdout.trim().split("\n").filter(Boolean);
      if (urls.length === 0) return reject(new Error("yt-dlp nije vratio URL"));
      resolve(urls[0]);
    });
  });
}

// ─── Text command router ──────────────────────────────────────────────────────

async function handleText(bot, chatId, text) {
  const lower = text.toLowerCase().trim();

  // ── Pause / Resume ────────────────────────────────────────────────────────
  if (/^(pauziraj|pause|pauza|nastavi|resume|unpause)$/i.test(lower)) {
    if (!isMpvRunning()) return bot.sendMessage(chatId, "ℹ️ Ništa se ne reproducira.");
    const isPaused = await pauseMpv();
    return bot.sendMessage(chatId, isPaused ? "⏸ Pauzirano." : "▶️ Nastavljam.");
  }

  // ── Progress ──────────────────────────────────────────────────────────────
  if (/^(napredak|progress|gdje|koliko|status)$/i.test(lower)) {
    if (!isMpvRunning()) return bot.sendMessage(chatId, "ℹ️ Ništa se ne reproducira.");
    const { position, duration, paused } = await getMpvProgress();
    if (position == null) return bot.sendMessage(chatId, "ℹ️ Ne mogu dohvatiti poziciju.");
    const pct = duration > 0 ? Math.round(position / duration * 100) : null;
    const bar = pct != null ? progressBar(pct) : "░░░░░░░░░░";
    const icon = paused ? "⏸" : "▶️";
    return bot.sendMessage(chatId,
      `${icon} ${fmtTime(position)} / ${fmtTime(duration)}\n${bar} ${pct != null ? pct + "%" : ""}`,
    );
  }

  // ── Stop / Cancel ─────────────────────────────────────────────────────────
  if (/\b(stop|zaustavi|ugasi|kraj|cancel|odustani)\b/i.test(lower)) {
    clearPending(chatId);

    // Cancel active download
    if (activeDownloads.has(chatId)) {
      const dl = activeDownloads.get(chatId);
      dl.controller.abort();
      activeDownloads.delete(chatId);
      return bot.sendMessage(chatId, `⏹ Preuzimanje <b>${esc(dl.title)}</b> otkazano.`, { parse_mode: "HTML" });
    }

    const stopped = stopMpv();
    return bot.sendMessage(chatId, stopped ? "⏹ Reprodukcija zaustavljena." : "ℹ️ Ništa se ne reproducira.");
  }

  // ── Resume/Restart choice (1 or 2) ───────────────────────────────────────
  const p = pendingSelection.get(chatId);
  if (p?._resumeChoice) {
    const n = parseChoice(lower);
    if (n === 1) {
      clearPending(chatId);
      launchMpv(p.filePath, p.title, (exitCode) => {
        if (exitCode === 4) {
          try { unlinkSync(p.filePath); } catch {}
          bot.sendMessage(chatId, `✅ <b>${esc(p.title)}</b> — kraj filma! Datoteka obrisana.`, { parse_mode: "HTML" }).catch(() => {});
        } else if (exitCode === 0) {
          bot.sendMessage(chatId, `⏸ <b>${esc(p.title)}</b> — pauzirano.`, { parse_mode: "HTML" }).catch(() => {});
        }
      });
      return bot.sendMessage(chatId, `▶️ Nastavljam <b>${esc(p.title)}</b>…`, { parse_mode: "HTML" });
    }
    if (n === 2) {
      clearPending(chatId);
      try { unlinkSync(p.filePath); } catch {}
      return downloadAndPlay(bot, chatId, p.stream, p.title, p.streamId, p.posterUrl);
    }
    return; // ignore other input while waiting for 1/2
  }

  // ── Stream selection (1-5) ────────────────────────────────────────────────
  const choice = parseChoice(lower);
  if (choice !== null && p && !p._resumeChoice) {
    clearPending(chatId);
    const stream = p.streams[choice - 1];
    if (!stream) return bot.sendMessage(chatId, `❌ Nema streama broj ${choice}.`);
    return startDownloadFlow(bot, chatId, stream, p.title, p.streamId, p.posterUrl);
  }

  // ── YouTube ───────────────────────────────────────────────────────────────
  const ytMatch = text.match(/^(?:youtube|yt)\s+(.+)/i);
  if (ytMatch) {
    const query = ytMatch[1].trim();
    await bot.sendMessage(chatId, `📺 <b>${esc(query)}</b>\n⏳ Dohvaćam YouTube link…`, { parse_mode: "HTML" });
    try {
      const url = await ytdlpGetUrl(query);
      // YouTube plays directly (no download — streams can't be saved easily)
      launchMpv(url, query);
      await bot.sendMessage(chatId, `▶️ <b>YouTube</b>\n\n📺 ${esc(query)}`, { parse_mode: "HTML" });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ yt-dlp greška: ${esc(err.message)}`);
    }
    return;
  }

  // ── Serija ────────────────────────────────────────────────────────────────
  const showMatch = text.match(/^(?:serija|series|show)\s+(.+)/i);
  if (showMatch) return playFlow(bot, chatId, showMatch[1].trim(), "series");

  // ── Film ──────────────────────────────────────────────────────────────────
  const movieMatch = text.match(/^(?:pusti|play|film|movie)\s+(.+)/i);
  if (movieMatch) return playFlow(bot, chatId, movieMatch[1].trim(), "movie");

  // ── /start ────────────────────────────────────────────────────────────────
  if (lower === "/start") {
    return bot.sendMessage(chatId,
      "👋 <b>Electro</b> — tvoj Pi 5 stream player\n\n" +
      "🎬 <code>pusti Inception</code>\n" +
      "📺 <code>serija Breaking Bad</code>\n" +
      "▶️ <code>youtube https://youtu.be/...</code>\n" +
      "🎙️ Glasovne poruke rade isto!\n" +
      "⏹ <code>stop</code> — zaustavi / otkaži preuzimanje",
      { parse_mode: "HTML" }
    );
  }
}

// ─── Message dispatcher ───────────────────────────────────────────────────────

function handleMessage(bot, msg) {
  const chatId = msg.chat.id;

  if (ALLOWED.size > 0 && !ALLOWED.has(chatId)) {
    return bot.sendMessage(chatId, "⛔ Unauthorized.");
  }

  if (OWNER_ID && msg.from.id !== OWNER_ID) {
    return bot.sendMessage(chatId, "⛔ Pristup odbijen.");
  }

  if (msg.voice) {
    handleVoice(bot, msg).catch((err) =>
      console.error("[Electro] handleVoice unhandled:", err.message)
    );
    return;
  }

  const text = (msg.text || "").trim();
  if (!text) return;

  handleText(bot, chatId, text).catch((err) =>
    console.error("[Electro] handleText unhandled:", err.message)
  );
}

// ─── Bot init ─────────────────────────────────────────────────────────────────

export function startElectroBot() {
  if (!TOKEN) return;

  const bot = new TelegramBot(TOKEN, { polling: true });
  console.log("[Electro] Bot pokrenut (polling).");

  bot.on("message", (msg) => handleMessage(bot, msg));
  bot.on("polling_error", (err) =>
    console.error("[Electro] Polling greška:", err.message || err)
  );

  return bot;
}
