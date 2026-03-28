import { Router } from "express";
import { getEnabledAddons } from "../services/addonStore.js";
import { getAddonMeta, getAddonSubtitles } from "../services/addonClient.js";

const router = Router();

/** Convert SRT to WebVTT (browsers only support VTT in <track>). SRT uses comma in timestamps, VTT uses dot. */
function srtToVtt(body) {
  const text = (typeof body === "string" ? body : Buffer.from(body).toString("utf-8")).replace(/\r\n/g, "\n");
  const withDots = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
  return "WEBVTT\n\n" + withDots;
}

/** GET /subtitles/proxy?url=... - fetch subtitle file and return with CORS; convert SRT to WebVTT if needed */
router.get("/proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string" || (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url" });
  }
  console.log("[StremioPI] Subtitle proxy: fetching " + rawUrl.slice(0, 80) + (rawUrl.length > 80 ? "..." : ""));
  try {
    const r = await fetch(rawUrl, { headers: { "User-Agent": "StremioPI/1.0" } });
    if (!r.ok) {
      console.log("[StremioPI] Subtitle proxy: upstream returned " + r.status);
      return res.status(r.status).send(r.statusText);
    }
    const buf = await r.arrayBuffer();
    const body = Buffer.from(buf);
    const text = body.toString("utf-8", 0, Math.min(body.length, 500));
    const looksLikeSrt = /^\d+\r?\n\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(text) || (/\d{2}:\d{2}:\d{2},\d{3}\s*-->/m.test(text) && !text.trimStart().startsWith("WEBVTT"));
    const isSrt = rawUrl.toLowerCase().includes(".srt") || (r.headers.get("content-type") || "").toLowerCase().includes("srt") || looksLikeSrt;
    if (isSrt) {
      res.set("Content-Type", "text/vtt; charset=utf-8");
      res.send(srtToVtt(body));
      console.log("[StremioPI] Subtitle proxy: converted SRT to VTT, " + body.length + " bytes");
    } else {
      res.set("Content-Type", r.headers.get("content-type") || "text/vtt; charset=utf-8");
      res.send(body);
      console.log("[StremioPI] Subtitle proxy: returned as-is, " + body.length + " bytes");
    }
  } catch (err) {
    console.error("[StremioPI] Subtitle proxy failed:", err.message || err);
    res.status(502).json({ error: "Failed to fetch subtitle" });
  }
});

/** Allow safe id chars (alphanumeric, underscore, colon, dot) */
const ID_REGEX = /^[a-zA-Z0-9_.:-]+$/;

/**
 * GET /subtitles/:id?type=movie|series&lang=hr
 * Returns list of subtitles from addons. For movie we resolve IMDB id when possible (addons like OpenSubtitles use tt...).
 * lang: optional; when set (e.g. hr), prefer that language first in the list.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const contentType = req.query.type === "series" ? "series" : "movie";
  const lang = typeof req.query.lang === "string" ? req.query.lang.toLowerCase().trim() : null;
  console.log("[StremioPI] GET /subtitles/" + id + " type=" + contentType + " lang=" + (lang || "any"));
  if (!id || !ID_REGEX.test(id)) {
    return res.status(400).json({ error: "Invalid id", id: id || "" });
  }

  const enabled = getEnabledAddons();
  let list = [];
  if (enabled.length > 0) {
    let subtitleId = id;
    if (contentType === "movie") {
      const meta = await getAddonMeta(enabled, "movie", id);
      if (meta && meta.imdbId) {
        subtitleId = meta.imdbId;
        console.log("[StremioPI] Using IMDB id for subtitles: " + subtitleId + " (from " + id + ")");
      }
    }
    list = await getAddonSubtitles(enabled, contentType, subtitleId);
  }

  if (lang && list.length > 0) {
    const codes = (lang === "hr" ? ["hr", "hrv"] : [lang]).map((c) => c.toLowerCase());
    const preferred = list.filter((s) => codes.includes((s.lang || "").toLowerCase()));
    const rest = list.filter((s) => !codes.includes((s.lang || "").toLowerCase()));
    list = preferred.length > 0 ? [...preferred, ...rest] : list;
  }

  console.log("[StremioPI] GET /subtitles/" + id + " type=" + contentType + " → " + list.length + " subtitle(s)");
  if (list.length === 0) {
    if (enabled.length === 0) {
      console.log("[StremioPI] No addons enabled. Add addons in the app Settings.");
    } else {
      console.log("[StremioPI] No subtitles found. In Settings, add and ENABLE a subtitle addon (e.g. OpenSubtitles v3). Stream addons (e.g. Torrentio) do not provide subtitles.");
    }
  }
  res.json({ id, subtitles: list });
});

export default router;
