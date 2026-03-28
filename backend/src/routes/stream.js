import { Router } from "express";
import { Readable } from "stream";
import { streams as streamsData } from "../data/mockData.js";
import { getEnabledAddons } from "../services/addonStore.js";
import { getAddonMeta, getAddonStreams } from "../services/addonClient.js";
import { isDebridEnabled } from "../services/debridService.js";

const router = Router();

/**
 * GET /stream/proxy?url=...
 * Proxies the video stream so playback works from other devices (e.g. TV, phone) and Cast
 * can load the URL. Forwards Range requests for seeking.
 */
router.get("/proxy", async (req, res) => {
  const rawUrl = req.query.url;
  if (!rawUrl || typeof rawUrl !== "string" || (!rawUrl.startsWith("http://") && !rawUrl.startsWith("https://"))) {
    return res.status(400).json({ error: "Invalid url" });
  }
  const range = req.headers.range;
  const opts = { headers: { "User-Agent": "StremioPI/1.0" } };
  if (range) opts.headers.Range = range;
  try {
    const r = await fetch(rawUrl, opts);
    if (!r.ok) return res.status(r.status).send(r.statusText);
    const contentType = r.headers.get("content-type") || "video/mp4";
    res.set("Content-Type", contentType);
    if (r.headers.get("content-length")) res.set("Content-Length", r.headers.get("content-length"));
    if (r.headers.get("accept-ranges")) res.set("Accept-Ranges", r.headers.get("accept-ranges"));
    if (r.status === 206 && r.headers.get("content-range")) res.set("Content-Range", r.headers.get("content-range"));
    res.status(r.status);
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    console.error("[StremioPI] Stream proxy failed:", err.message || err);
    res.status(502).json({ error: "Stream proxy failed" });
  }
});

/** Allow safe id chars (alphanumeric, underscore, colon, dot) */
const ID_REGEX = /^[a-zA-Z0-9_.:-]+$/;

/**
 * GET /stream/:id?type=movie|series
 * Returns array of stream objects. For movies we resolve IMDB id from meta; for series the id is the episode id (e.g. tt123:1:1).
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const contentType = req.query.type === "series" ? "series" : "movie";
  console.log("[StremioPI] GET /stream/" + id + " type=" + contentType);
  if (!id || !ID_REGEX.test(id)) {
    return res.status(400).json({ error: "Invalid id", id: id || "" });
  }

  const enabled = getEnabledAddons();
  let list;
  if (enabled.length > 0) {
    let streamId = id;
    if (contentType === "movie") {
      const meta = await getAddonMeta(enabled, "movie", id);
      if (meta && meta.imdbId) {
        streamId = meta.imdbId;
        console.log("[StremioPI] Using IMDB id for streams: " + streamId + " (from " + id + ")");
      }
    }
    list = await getAddonStreams(enabled, contentType, streamId);
  } else {
    list = streamsData[id];
  }

  if (!list || list.length === 0) {
    const message =
      enabled.length > 0
        ? isDebridEnabled()
          ? "Addons returned 0 streams for this title. Try another title or add/configure addons (e.g. Torrentio) in Settings."
          : "Addons may only have torrent links. Set REAL_DEBRID_TOKEN in backend to resolve them."
        : "No streams for this title. Add addons in Settings.";
    return res.status(200).json({ id, streams: [], message });
  }

  res.json({ id, streams: list });
});

export default router;
