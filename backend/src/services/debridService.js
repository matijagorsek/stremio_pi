/**
 * Real-Debrid integration: resolve torrent (infoHash) to direct HTTP link.
 * Set REAL_DEBRID_TOKEN in env (get token from https://real-debrid.com/apitoken).
 * When set, addon streams with infoHash are resolved via RD and returned as HTTP URLs.
 */

const RD_BASE = "https://api.real-debrid.com/rest/1.0";
const TOKEN = process.env.REAL_DEBRID_TOKEN || process.env.DEBRID_TOKEN || "";
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 45; // ~90s max wait

function rdRequest(method, path, body = null) {
  if (!TOKEN) return Promise.reject(new Error("DEBRID_TOKEN not set"));
  const url = `${RD_BASE}${path}`;
  const opts = {
    method,
    headers: { Authorization: `Bearer ${TOKEN}` },
  };
  if (body && (method === "POST" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/x-www-form-urlencoded";
    opts.body = typeof body === "string" ? body : new URLSearchParams(body).toString();
  }
  return fetch(url, opts).then((res) => {
    if (res.status === 204) return null;
    return res.json().then((data) => {
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    });
  });
}

/**
 * Resolve torrent (infoHash, optional fileIdx) to a direct HTTP stream URL via Real-Debrid.
 * Returns Promise<string> URL or Promise.reject.
 */
export async function resolveTorrentToUrl(infoHash, fileIdx = null) {
  if (!infoHash || !TOKEN) return Promise.reject(new Error("Missing infoHash or token"));
  const magnet = `magnet:?xt=urn:btih:${String(infoHash).toLowerCase()}`;

  const add = await rdRequest("POST", "/torrents/addMagnet", { magnet });
  if (!add || !add.id) throw new Error("Real-Debrid add magnet failed");

  const id = add.id;
  await rdRequest("POST", `/torrents/selectFiles/${id}`, { files: "all" });

  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const info = await rdRequest("GET", `/torrents/info/${id}`);
    if (!info) continue;
    if (info.status === "downloaded" && info.links && info.links.length > 0) {
      const hostLink = fileIdx != null && info.links[fileIdx] != null ? info.links[fileIdx] : info.links[0];
      if (!hostLink) return info.links[0];
      // RD torrent info returns hoster links; unrestrict to get direct download URL
      try {
        const unrestrict = await rdRequest("POST", "/unrestrict/link", { link: hostLink });
        if (unrestrict && unrestrict.download && unrestrict.download.startsWith("http")) return unrestrict.download;
      } catch (_) {}
      return hostLink;
    }
    if (info.status === "error" || info.status === "dead") throw new Error(info.status || "Torrent failed");
  }

  throw new Error("Real-Debrid timeout");
}

export function isDebridEnabled() {
  return Boolean(TOKEN);
}
