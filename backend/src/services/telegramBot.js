/**
 * Electro — Telegram bot za filmove, serije i YouTube na Raspberry Pi 5.
 *
 * Komande (tekst ili glasovna poruka):
 *   pusti <film>          — traži film i nudi stream
 *   serija <naziv>        — traži seriju i nudi stream
 *   youtube <url|naziv>   — reproducira YouTube video
 *   stop / zaustavi       — zaustavlja reprodukciju
 *   1–5 / jedan–pet       — bira stream iz ponuđene liste
 */

import TelegramBot from "node-telegram-bot-api";
import { execFile, execFileSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { getEnabledAddons } from "./addonStore.js";
import { getAddonSearch, getAddonStreams, getAddonMeta } from "./addonClient.js";
import { launchMpv, stopMpv } from "./playerService.js";

const TOKEN    = process.env.ELECTRO_BOT_TOKEN;
const OWNER_ID = process.env.ELECTRO_OWNER_ID ? Number(process.env.ELECTRO_OWNER_ID) : null;

if (!TOKEN) {
  console.warn("[Electro] ELECTRO_BOT_TOKEN nije postavljen — bot se ne pokreće.");
}

// ─── Pending stream selections ────────────────────────────────────────────────
/** chatId → { streams, title, type, timer } */
const pending = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(t) {
  return String(t || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Croatian + English number words → 1-5, or parse digit string */
function parseChoice(text) {
  const t = text.trim().toLowerCase();
  const words = { jedan: 1, jedna: 1, one: 1, "1": 1,
                  dva: 2, dvije: 2, two: 2, "2": 2,
                  tri: 3, three: 3, "3": 3,
                  četiri: 4, cetiri: 4, four: 4, "4": 4,
                  pet: 5, five: 5, "5": 5 };
  if (words[t]) return words[t];
  const n = parseInt(t, 10);
  return n >= 1 && n <= 5 ? n : null;
}

/** Quality + codec label, e.g. "1080p HEVC" */
function qualityLabel(s) {
  const n = (s.name || "").toLowerCase();
  const res  = n.includes("4k") || n.includes("2160p") ? "4K"
             : n.includes("1080p") ? "1080p"
             : n.includes("720p")  ? "720p"
             : n.includes("480p")  ? "480p"
             : "?";
  const codec = n.includes("hevc") || n.includes("x265") || n.includes("h265") ? " HEVC"
              : n.includes("x264") || n.includes("h264") || n.includes("avc")   ? " h264"
              : "";
  return res + codec;
}

/**
 * Pi 5 ima hardware HEVC decode → preferiramo HEVC streamove.
 * Redoslijed: 1080p HEVC → 720p HEVC → 1080p h264 → 720p h264 → ostalo → 4K
 */
function sortStreams(streams) {
  const score = (s) => {
    const n = (s.name || "").toLowerCase();
    const is4k   = n.includes("4k") || n.includes("2160p");
    const is1080 = n.includes("1080p");
    const is720  = n.includes("720p");
    const is480  = n.includes("480p");
    const isHevc = n.includes("hevc") || n.includes("x265") || n.includes("h265");
    if (is4k)             return 10;
    if (is1080 && isHevc) return 0;
    if (is720  && isHevc) return 1;
    if (is1080)           return 2;
    if (is720)            return 3;
    if (is480)            return 5;
    return 4;
  };
  return [...streams].sort((a, b) => score(a) - score(b));
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
  const tmp    = tmpdir();
  const oggPath = join(tmp, `electro_${stamp}.ogg`);
  const wavPath = join(tmp, `electro_${stamp}.wav`);

  try {
    await bot.sendMessage(chatId, "🎙️ Slušam…");

    // 1. Download OGG
    const fileLink = await bot.getFileLink(msg.voice.file_id);
    const res = await fetch(fileLink);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(oggPath, buf);

    // 2. OGG → WAV 16kHz mono (Whisper format)
    execFileSync("ffmpeg", ["-y", "-i", oggPath, "-ar", "16000", "-ac", "1", wavPath], { stdio: "pipe" });

    // 3. Whisper transcription
    const text = await transcribeAudio(wavPath);
    console.log(`[Electro] 🎙️ Transkripcija: "${text}"`);

    if (!text) {
      await bot.sendMessage(chatId, "🤔 Nisam razumio — pokušaj ponovo.");
      return;
    }

    await bot.sendMessage(chatId, `🎙️ <i>${esc(text)}</i>`, { parse_mode: "HTML" });

    // 4. Process transcribed text as a regular command
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

  if (sorted.length === 1) {
    return launchStream(bot, chatId, sorted[0], label);
  }

  const top5 = sorted.slice(0, 5);
  const lines = top5.map((s, i) => {
    const q    = qualityLabel(s);
    const name = (s.name || "Stream").replace(/\n/g, " ").slice(0, 50);
    return `${i + 1}. <b>${q}</b> — ${esc(name)}`;
  });

  clearPending(chatId);

  const timer = setTimeout(() => {
    pending.delete(chatId);
    bot.sendMessage(chatId, "⏱ Isteklo vrijeme odabira.").catch(() => {});
  }, 90_000);

  pending.set(chatId, { streams: top5, title: label, type, timer });

  await bot.sendMessage(chatId,
    `🎬 <b>${esc(label)}</b>\n\nOdaberi stream (odgovori brojem 1–${top5.length}):\n\n${lines.join("\n")}`,
    { parse_mode: "HTML" }
  );
}

async function launchStream(bot, chatId, stream, title) {
  try {
    launchMpv(stream.url, title);
    await bot.sendMessage(chatId,
      `▶️ <b>Reproducira se!</b>\n\n🎬 ${esc(title)}\n📺 ${esc(stream.name || "Stream")}`,
      { parse_mode: "HTML" }
    );
  } catch (err) {
    await bot.sendMessage(chatId, `❌ Greška pri pokretanju: ${esc(err.message)}`);
  }
}

function clearPending(chatId) {
  const p = pending.get(chatId);
  if (p) { clearTimeout(p.timer); pending.delete(chatId); }
}

// ─── Text command router ──────────────────────────────────────────────────────

async function handleText(bot, chatId, text) {
  const lower = text.toLowerCase().trim();

  // Stop
  if (/\b(stop|zaustavi|ugasi|kraj|pauza)\b/i.test(lower)) {
    clearPending(chatId);
    const stopped = stopMpv();
    return bot.sendMessage(chatId, stopped ? "⏹ Reprodukcija zaustavljena." : "ℹ️ Ništa se ne reproducira.");
  }

  // Stream selection (pending list)
  const choice = parseChoice(lower);
  if (choice !== null && pending.has(chatId)) {
    const p = pending.get(chatId);
    clearPending(chatId);
    const stream = p.streams[choice - 1];
    if (!stream) return bot.sendMessage(chatId, `❌ Nema streama broj ${choice}.`);
    return launchStream(bot, chatId, stream, p.title);
  }

  // YouTube
  const ytMatch = text.match(/^(?:youtube|yt)\s+(.+)/i);
  if (ytMatch) {
    const query = ytMatch[1].trim();
    await bot.sendMessage(chatId, `📺 YouTube: <b>${esc(query)}</b>\n⏳ Dohvaćam link…`, { parse_mode: "HTML" });
    try {
      const url = await ytdlpGetUrl(query);
      launchMpv(url, query);
      await bot.sendMessage(chatId, `▶️ <b>YouTube reproducira!</b>\n\n📺 ${esc(query)}`, { parse_mode: "HTML" });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ yt-dlp greška: ${esc(err.message)}`);
    }
    return;
  }

  // Serija
  const showMatch = text.match(/^(?:serija|series|show)\s+(.+)/i);
  if (showMatch) return playFlow(bot, chatId, showMatch[1].trim(), "series");

  // Film
  const movieMatch = text.match(/^(?:pusti|play|film|movie)\s+(.+)/i);
  if (movieMatch) return playFlow(bot, chatId, movieMatch[1].trim(), "movie");

  // /start
  if (lower === "/start") {
    return bot.sendMessage(chatId,
      "👋 <b>Electro</b> — tvoj Pi 5 stream player\n\n" +
      "🎬 <code>pusti Inception</code>\n" +
      "📺 <code>serija Breaking Bad</code>\n" +
      "▶️ <code>youtube https://youtu.be/...</code>\n" +
      "🎙️ Glasovne poruke rade isto!\n" +
      "⏹ <code>stop</code> — zaustavi reprodukciju",
      { parse_mode: "HTML" }
    );
  }
}

// ─── Message handler (dispatcher) ────────────────────────────────────────────

function handleMessage(bot, msg) {
  const chatId = msg.chat.id;

  // Owner-only guard
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
