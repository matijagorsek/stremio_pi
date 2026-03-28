/**
 * Stremio addon HTTP client. Fetches catalog, meta, streams from one or more addon URLs
 * and maps responses to StremioPI API shape. Addons are provided by addonStore (DB).
 * When REAL_DEBRID_TOKEN is set, torrent streams (infoHash) are resolved to HTTP via Real-Debrid.
 */
import { isDebridEnabled, resolveTorrentToUrl } from "./debridService.js";

const ADDON_FETCH_TIMEOUT_MS = 10000;

function fetchAddon(baseUrl, path) {
  const base = baseUrl.replace(/\/?$/, "/");
  const url = path.startsWith("http") ? path : `${base}${path.replace(/^\//, "")}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ADDON_FETCH_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(`Addon ${res.status}`);
      return res.json();
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error("Addon request timed out");
      throw err;
    });
}

/** Map Stremio meta preview to our catalog item. Include rating and runtime when present. */
function mapCatalogItem(m) {
  if (!m || !m.id) return null;
  const rawRating = m.rating ?? m.imdbRating ?? m.vote_average ?? m.voteAverage;
  const rating = rawRating != null ? (typeof rawRating === "number" ? rawRating : parseFloat(String(rawRating))) : null;
  const runtime = m.runtime != null ? m.runtime : null;
  const out = {
    id: m.id,
    type: m.type || "movie",
    title: m.name || m.title || m.id,
    poster: m.poster || "",
    year: m.year ?? (m.releaseInfo ? parseInt(m.releaseInfo, 10) : null),
  };
  if (rating != null && !Number.isNaN(rating)) out.rating = rating;
  if (runtime != null && (typeof runtime === "string" || typeof runtime === "number")) out.runtime = runtime;
  if (m.genres && Array.isArray(m.genres) && m.genres.length > 0) out.genres = m.genres.filter((g) => g && String(g).trim());
  return out;
}

/** Map Stremio meta to our meta. Include imdbId and videos (for series episodes). */
function mapMeta(m) {
  if (!m || !m.id) return null;
  const imdbId = m.imdb_id || (m.ids && m.ids.imdb) || (String(m.id).match(/^tt\d+$/) ? m.id : null) || null;
  const out = {
    id: m.id,
    type: m.type || "movie",
    name: m.name || m.title || m.id,
    description: m.description || "",
    poster: m.poster || "",
    releaseInfo: m.releaseInfo || null,
    runtime: m.runtime || null,
  };
  if (imdbId) out.imdbId = imdbId;
  if (m.videos && Array.isArray(m.videos) && m.videos.length > 0) out.videos = m.videos.map((v) => ({ id: v.id, title: v.title || v.name, season: v.season, episode: v.episode }));
  return out;
}

/** Map Stremio stream to our stream; only include HTTP URL streams (TV app can't play torrents) */
function mapStream(s) {
  if (!s) return null;
  const url = s.url;
  if (!url || !url.startsWith("http") || url.startsWith("magnet:")) return null;
  const type = url.includes(".m3u8") ? "hls" : url.includes(".mp4") || url.match(/\.mp4(\?|$)/) ? "mp4" : "hls";
  return { name: s.name || s.title || "Stream", url, type };
}

/** Extract BTIH (infoHash) from magnet link, or return null */
function infoHashFromMagnet(url) {
  if (!url || typeof url !== "string" || !url.startsWith("magnet:")) return null;
  const match = url.match(/xt=urn:btih:([a-fA-F0-9]{40}|[a-zA-Z2-7]{32})/);
  return match ? match[1] : null;
}

/** Get all catalog entries for type from addon manifest: { id, name } */
function getCatalogsForType(baseUrl, type) {
  return fetchAddon(baseUrl, "manifest.json")
    .then((manifest) => {
      const catalogs = manifest && manifest.catalogs ? manifest.catalogs : [];
      return catalogs.filter((c) => c.type === type).map((c) => ({ id: c.id, name: c.name || c.id })).filter((c) => c.id);
    })
    .catch(() => []);
}

/** Get all catalog ids for type (for internal use) */
function getCatalogIdsForType(baseUrl, type) {
  return getCatalogsForType(baseUrl, type).then((arr) => (arr.length > 0 ? arr.map((c) => c.id) : ["top"]));
}

/**
 * Returns catalog options per type from enabled addons: { movie: [{ id, name }], series: [...] }.
 * Dedupes by id (first name wins).
 */
export function getCatalogOptions(addons) {
  if (!addons || addons.length === 0) return Promise.resolve({ movie: [], series: [] });
  return Promise.all(
    ["movie", "series"].map((type) =>
      Promise.all(addons.map((a) => getCatalogsForType(a.baseUrl, type))).then((arrays) => {
        const byId = new Map();
        arrays.flat().forEach((c) => { if (c.id && !byId.has(c.id)) byId.set(c.id, c.name); });
        return Array.from(byId.entries(), ([id, name]) => ({ id, name }));
      })
    )
  ).then(([movie, series]) => ({ movie, series }));
}

/**
 * Fetches catalog. When catalogId is set, only that catalog is requested; otherwise all catalogs for the type are merged.
 */
export function getAddonCatalog(addons, type = "movie", catalogId = null) {
  if (!addons || addons.length === 0) return Promise.resolve([]);
  let catalogSampleLogged = false;
  const fetchOne = (baseUrl, id) =>
    fetchAddon(baseUrl, `catalog/${type}/${id}.json`)
      .then((data) => {
        const metas = data && data.metas ? data.metas : [];
        if (metas.length > 0 && !catalogSampleLogged) {
          catalogSampleLogged = true;
          const sample = metas[0];
          const ratingFields = ["rating", "imdbRating", "vote_average", "voteAverage"].filter((k) => sample[k] !== undefined);
          console.log("[StremioPI] Catalog sample keys: " + Object.keys(sample).join(", ") + (ratingFields.length ? " | rating-like: " + ratingFields.map((k) => k + "=" + sample[k]).join(", ") : " | no rating field"));
        }
        return metas.map(mapCatalogItem).filter(Boolean);
      })
      .catch(() => []);
  return Promise.all(
    addons.map((addon) => {
      if (catalogId) return fetchOne(addon.baseUrl, catalogId).then((arr) => arr);
      return getCatalogIdsForType(addon.baseUrl, type).then((ids) =>
        Promise.all(ids.map((id) => fetchOne(addon.baseUrl, id))).then((arrays) => arrays.flat())
      );
    })
  ).then((arrays) => {
    const seen = new Set();
    const merged = [];
    for (const arr of arrays) {
      for (const item of arr) {
        if (!seen.has(item.id)) { seen.add(item.id); merged.push(item); }
      }
    }
    return merged;
  });
}

/** Search across addons: tries catalog/type/id/search=query.json for each catalog of that type. */
export function getAddonSearch(addons, type, query) {
  if (!addons || addons.length === 0 || !query || !String(query).trim()) return Promise.resolve([]);
  const q = String(query).trim();
  return Promise.all(
    addons.map((addon) =>
      getCatalogIdsForType(addon.baseUrl, type).then((catalogIds) =>
        Promise.all(
          catalogIds.map((catalogId) =>
            fetchAddon(addon.baseUrl, `catalog/${type}/${catalogId}/search=${encodeURIComponent(q)}.json`)
              .then((data) => (data && data.metas ? data.metas : []).map(mapCatalogItem).filter(Boolean))
              .catch(() => [])
          )
        ).then((arrays) => arrays.flat())
      )
    )
  ).then((arrays) => {
    const seen = new Set();
    const merged = [];
    for (const arr of arrays) {
      for (const item of arr) {
        if (!seen.has(item.id)) { seen.add(item.id); merged.push(item); }
      }
    }
    return merged;
  });
}

/** IDs to try for meta (e.g. tmdb:55121 -> [tmdb:55121, 55121]); some addons expect only the numeric part. */
function metaIdVariants(id) {
  if (!id || typeof id !== "string") return [id];
  const match = id.match(/^(tmdb|tvdb|imdb):(\d+)$/i);
  if (match) return [id, match[2]];
  return [id];
}

export function getAddonMeta(addons, type, id) {
  if (!addons || addons.length === 0) return Promise.resolve(null);
  const baseUrls = addons.map((a) => a.baseUrl);
  const idsToTry = metaIdVariants(id);

  function tryIds(idList) {
    if (idList.length === 0) return Promise.resolve(null);
    const tryId = idList[0];
    const path = `meta/${type}/${encodeURIComponent(tryId)}.json`;
    return baseUrls.reduce(
      (p, base) =>
        p.then((found) => {
          if (found) {
            if (tryId !== id && found.id) found.id = id;
            return found;
          }
          return fetchAddon(base, path)
            .then((data) => {
              const meta = data && data.meta ? data.meta : data;
              const mapped = mapMeta(meta);
              if (mapped && tryId !== id) mapped.id = id;
              return mapped;
            })
            .catch(() => null);
        }),
      Promise.resolve(null)
    ).then((found) => {
      if (found) return found;
      return tryIds(idList.slice(1));
    });
  }

  return tryIds(idsToTry);
}

export function getAddonStreams(addons, type, id) {
  if (!addons || addons.length === 0) return Promise.resolve([]);
  const baseUrls = addons.map((a) => a.baseUrl);
  const path = `stream/${type}/${encodeURIComponent(id)}.json`;
  return Promise.all(
    baseUrls.map((base) =>
      fetchAddon(base, path)
        .then((data) => (data && data.streams ? data.streams : []))
        .catch(() => [])
    )
  ).then((streamArrays) => {
    const rawStreams = streamArrays.flat();
    const httpStreams = rawStreams.map(mapStream).filter(Boolean);
    const torrentStreams = rawStreams.filter((s) => {
      if (!s) return false;
      if (s.url && s.url.startsWith("http") && !s.url.startsWith("magnet:")) return false;
      return s.infoHash || s.info_hash || infoHashFromMagnet(s.url);
    });
    console.log("[StremioPI] Addons returned " + rawStreams.length + " stream(s): " + httpStreams.length + " HTTP, " + torrentStreams.length + " torrent.");
    if (torrentStreams.length === 0 || !isDebridEnabled()) return httpStreams;
    const maxResolve = 5;
    const toResolve = torrentStreams.slice(0, maxResolve);
    console.log("[StremioPI] Resolving up to " + toResolve.length + " torrent stream(s) via Real-Debrid (rate-limited)...");
    const getInfoHash = (s) => s.infoHash || s.info_hash || infoHashFromMagnet(s.url);
    const fileIdx = (s) => (s.fileIdx != null ? s.fileIdx : s.file_idx != null ? s.file_idx : null);
    const delayMs = 1500;
    const resolveOne = (s) => {
      const hash = getInfoHash(s);
      if (!hash) return Promise.resolve(null);
      return resolveTorrentToUrl(hash, fileIdx(s)).then((url) => ({ name: s.name || s.title || "Stream (RD)", url, type: "mp4" })).catch((err) => {
        if (err && err.message !== "too_many_requests") console.error("[StremioPI] Torrent resolve failed:", err.message || err);
        return null;
      });
    };
    return toResolve.reduce((p, s, i) => p.then((resolved) => {
      if (i > 0) return new Promise((r) => setTimeout(r, delayMs)).then(() => resolveOne(s).then((v) => (v ? resolved.concat(v) : resolved)));
      return resolveOne(s).then((v) => (v ? resolved.concat(v) : resolved));
    }), Promise.resolve([])).then((resolved) => [...httpStreams, ...resolved]);
  });
}

/** Map Stremio subtitle to our shape: { id, url, lang }. Only HTTP URLs. */
function mapSubtitle(s) {
  if (!s || !s.url || typeof s.url !== "string" || !s.url.startsWith("http")) return null;
  return { id: s.id || s.url, url: s.url, lang: (s.lang && String(s.lang).toLowerCase()) || "en" };
}

/**
 * Get subtitles from enabled addons for a video. Stremio: subtitles/{type}/{id}.json (id = video/episode id, e.g. tt123 or tt123:1:1).
 * Returns merged list; caller can filter by lang.
 */
export function getAddonSubtitles(addons, type, id) {
  if (!addons || addons.length === 0) return Promise.resolve([]);
  const baseUrls = addons.map((a) => a.baseUrl);
  const path = `subtitles/${type}/${encodeURIComponent(id)}.json`;
  return Promise.all(
    baseUrls.map((base) =>
      fetchAddon(base, path)
        .then((data) => (data && data.subtitles ? data.subtitles : []))
        .catch(() => [])
    )
  ).then((arrays) => {
    const merged = arrays.flat().map(mapSubtitle).filter(Boolean);
    const seen = new Set();
    const out = merged.filter((s) => {
      const key = s.url + "|" + s.lang;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (out.length === 0) {
      console.log("[StremioPI] Addons returned 0 subtitles for " + type + "/" + id);
    }
    return out;
  });
}
