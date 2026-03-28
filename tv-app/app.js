/**
 * StremioPI TV app – list, detail, player. Keyboard nav + MPV video.
 * Phase 3: fetches catalog, meta, and streams from backend API.
 */

const state = {
  view: "list",
  catalog: [],
  catalogTotal: 0,
  catalogType: "all",
  catalogId: "",
  catalogOptions: { movie: [], series: [] },
  catalogLoadingMore: false,
  searchQuery: "",
  isSearchResults: false,
  selectedIndex: 0,
  currentItem: null,
  currentEpisode: null,
  currentStream: null,
  availableStreams: [],
  addons: [],
};

// ----- API config -----
// Override with ?api=... or window.StremioPI_API_BASE.
// When unset: localhost on a port other than 3000 → backend assumed on 3000 (dev); else same origin (deploy).
function getApiBase() {
  if (typeof window === "undefined") return "http://localhost:3000";
  if (window.StremioPI_API_BASE !== undefined && window.StremioPI_API_BASE !== "") return window.StremioPI_API_BASE;
  const origin = window.location && window.location.origin;
  const isLocal = origin && (origin.includes("localhost") || origin.includes("127.0.0.1"));
  const port = window.location && window.location.port;
  if (isLocal && port !== "3000") return "http://localhost:3000";
  return origin || "http://localhost:3000";
}
const API_BASE = getApiBase();

// ----- DOM refs -----
const listView = document.getElementById("list-view");
const detailView = document.getElementById("detail-view");
const playerView = document.getElementById("player-view");
const catalogGrid = document.getElementById("catalog-grid");
const detailBack = document.getElementById("detail-back");
const detailPoster = document.getElementById("detail-poster");
const detailTitle = document.getElementById("detail-title");
const detailMeta = document.getElementById("detail-meta");
const detailDescription = document.getElementById("detail-description");
const detailContent = document.getElementById("detail-content");
const detailEpisodes = document.getElementById("detail-episodes");
const playBtn = document.getElementById("play-btn");
const playerClose = document.getElementById("player-close");
const a11yAnnouncer = document.getElementById("a11y-announcer");
const catalogLoading = document.getElementById("catalog-loading");
const catalogErrorWrap = document.getElementById("catalog-error-wrap");
const catalogError = document.getElementById("catalog-error");
const catalogRetryBtn = document.getElementById("catalog-retry-btn");
const detailLoading = document.getElementById("detail-loading");
const detailError = document.getElementById("detail-error");
const detailStreamError = document.getElementById("detail-stream-error");
const settingsView = document.getElementById("settings-view");
const settingsBack = document.getElementById("settings-back");
const addonsList = document.getElementById("addons-list");
const addonsLoading = document.getElementById("addons-loading");
const addonsError = document.getElementById("addons-error");
const addonUrlInput = document.getElementById("addon-url-input");
const addonNameInput = document.getElementById("addon-name-input");
const addonAddBtn = document.getElementById("addon-add-btn");
const addonFormMessage = document.getElementById("addon-form-message");
const suggestedAddons = document.getElementById("suggested-addons");
const openSettingsBtn = document.getElementById("open-settings-btn");
const catalogTabs = document.getElementById("catalog-tabs");
const tabAll = document.getElementById("tab-all");
const tabMovies = document.getElementById("tab-movies");
const tabSeries = document.getElementById("tab-series");
const catalogScroll = document.getElementById("catalog-scroll");
const catalogSentinel = document.getElementById("catalog-sentinel");
const catalogSelect = document.getElementById("catalog-select");
const searchInput = document.getElementById("search-input");
const searchBtn = document.getElementById("search-btn");
const streamPicker = document.getElementById("stream-picker");
const streamPickerList = document.getElementById("stream-picker-list");
const streamsLoading = document.getElementById("streams-loading");

function announce(message) {
  if (!a11yAnnouncer) return;
  a11yAnnouncer.textContent = "";
  requestAnimationFrame(() => {
    a11yAnnouncer.textContent = message;
  });
}

function showEl(el, show) {
  if (!el) return;
  el.classList.toggle("hidden", !show);
}

// ----- API fetch -----
const API_TIMEOUT_MS = 15000;

function apiGet(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), opts.timeoutMs != null ? opts.timeoutMs : API_TIMEOUT_MS);
  return fetch(url, { signal: controller.signal })
    .then((res) => {
      clearTimeout(timeoutId);
      if (!res.ok) throw new Error(res.statusText || String(res.status));
      return res.json();
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") throw new Error("Request timed out");
      throw err;
    });
}

function apiPatch(path, body) {
  const url = path.startsWith("http") ? path : `${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((res) => {
    if (!res.ok) throw new Error(res.statusText || String(res.status));
    return res.status === 204 ? null : res.json();
  });
}

function apiPost(path, body) {
  const url = path.startsWith("http") ? path : `${API_BASE.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((res) => {
    if (!res.ok) throw new Error(res.statusText || String(res.status));
    return res.json();
  });
}

const CATALOG_PAGE_SIZE = 24;

function getCatalog(type, offset, limit, catalogId) {
  const params = new URLSearchParams();
  params.set("type", type === "movie" || type === "series" ? type : "all");
  if (catalogId) params.set("catalogId", catalogId);
  if (offset != null && offset > 0) params.set("offset", String(offset));
  if (limit != null && limit > 0) params.set("limit", String(limit));
  return apiGet("/catalog?" + params.toString()).then((data) => ({
    items: (data && data.items) ? data.items : [],
    total: (data && data.total != null) ? data.total : 0,
  }));
}

function getCatalogOptions() {
  return apiGet("/catalog/options").then((data) => ({
    movie: (data && data.movie) ? data.movie : [],
    series: (data && data.series) ? data.series : [],
  })).catch(() => ({ movie: [], series: [] }));
}

function searchCatalog(type, q) {
  if (!q || !String(q).trim()) return Promise.resolve({ items: [], total: 0 });
  return apiGet("/search?type=" + (type === "series" ? "series" : "movie") + "&q=" + encodeURIComponent(String(q).trim())).then((data) => ({
    items: (data && data.items) ? data.items : [],
    total: (data && data.total != null) ? data.total : 0,
  }));
}

function getMeta(id, type) {
  const typeParam = type === "series" ? "?type=series" : "";
  return apiGet(`/meta/${encodeURIComponent(id)}${typeParam}`).then((data) => data || null);
}

function getStreams(id, type) {
  const typeParam = type === "series" ? "?type=series" : "";
  const url = `${API_BASE.replace(/\/$/, "")}/stream/${encodeURIComponent(id)}${typeParam}`;
  return fetch(url)
    .then((res) => res.json().then((data) => ({ ok: res.ok, status: res.status, data })))
    .then(({ ok, data }) => {
      if (!ok) return Promise.reject(data || {});
      return { streams: (data && data.streams) ? data.streams : [], message: (data && data.message) ? data.message : null };
    });
}

function getAddons() {
  return apiGet("/addons").then((data) => (data && data.addons) ? data.addons : []);
}

function patchAddon(id, body) {
  return apiPatch(`/addons/${id}`, body);
}

function addAddon(baseUrl, name) {
  return apiPost("/addons", { baseUrl, name: name || null });
}

// Suggested addons. All work at this URL (no configure step). From https://github.com/hritikvalluvar/stremio-setup and verified.
const KNOWN_ADDONS = [
  { name: "Torrentio", url: "https://torrentio.strem.fun/", note: "Streams (YTS, EZTV, TPB, etc.). Set Real-Debrid in backend for direct links." },
  { name: "Torrentio Lite", url: "https://torrentio.strem.fun/lite/", note: "Lighter Torrentio: YTS, EZTV, RARBG, 1337x, TPB, etc. Real-Debrid for direct links." },
  { name: "ThePirateBay+", url: "https://thepiratebay-plus.strem.fun/", note: "Streams from The Pirate Bay. Use with Real-Debrid for direct links." },
  { name: "TorrentsDB", url: "https://torrentsdb.com/", note: "Streams. Use with Real-Debrid for direct links." },
  { name: "Cinemeta (official)", url: "https://v3-cinemeta.strem.io/", note: "Catalog + meta (IMDB). Use with Torrentio/TorrentsDB for streams." },
  { name: "The Movie Database (TMDB)", url: "https://94c8cb9f702d-tmdb-addon.baby-beamup.club/", note: "Catalog + meta. Use with Torrentio/TorrentsDB for streams." },
  { name: "OpenSubtitles v3", url: "https://opensubtitles-v3.strem.io/", note: "Subtitles for movies and series." },
];

// ----- Render -----
function showView(name) {
  state.view = name;
  listView.classList.toggle("hidden", name !== "list");
  detailView.classList.toggle("hidden", name !== "detail");
  playerView.classList.toggle("hidden", name !== "player");
  if (settingsView) settingsView.classList.toggle("hidden", name !== "settings");
  if (name === "list") announce("Catalog");
  else if (name === "detail") announce("Details");
  else if (name === "player") announce("Playing in MPV");
  else if (name === "settings") announce("Settings");
}

function formatRuntime(runtime) {
  if (runtime == null) return "";
  if (typeof runtime === "string") {
    const s = runtime.trim();
    if (!s) return "";
    if (/^\d+h\d+min?$/i.test(s)) return s.replace(/^(\d+)(h)(\d+)(min?)$/i, "$1h $3min");
    if (/^\d+\s*min(?:ute)?s?$/i.test(s)) return s;
    return s;
  }
  const n = Number(runtime);
  if (Number.isNaN(n) || n < 0) return "";
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  if (h > 0 && m > 0) return h + "h " + m + "min";
  if (h > 0) return h + "h";
  return m + "min";
}

function createCatalogCard(item, i) {
  const card = document.createElement("a");
  card.href = "#";
  card.className = "catalog-item";
  card.role = "listitem";
  card.tabIndex = i === state.selectedIndex ? 0 : -1;
  card.dataset.index = String(i);
  const ratingStr = item.rating != null && !Number.isNaN(item.rating) ? "★ " + (Number(item.rating) === item.rating ? item.rating.toFixed(1) : item.rating) : "";
  const runtimeStr = formatRuntime(item.runtime);
  const genreStr = item.genres && item.genres.length > 0 ? item.genres.slice(0, 3).join(", ") : "";
  const metaStr = [ratingStr, runtimeStr, genreStr].filter(Boolean).join(" · ");
  card.innerHTML = `
    <div class="poster-wrap">
      <img src="${escapeAttr(item.poster)}" alt="" loading="lazy" />
    </div>
    <h3 class="title">${escapeHtml(item.title)}</h3>
    ${metaStr ? `<p class="catalog-item-meta">${escapeHtml(metaStr)}</p>` : ""}
  `;
  card.addEventListener("click", (e) => {
    e.preventDefault();
    openDetail(i);
  });
  return card;
}

function renderList(opts) {
  if (!catalogGrid) return;
  const skipFocus = opts && opts.skipFocus;
  showEl(catalogLoading, false);
  catalogGrid.innerHTML = "";
  state.catalog.forEach((item, i) => {
    catalogGrid.appendChild(createCatalogCard(item, i));
  });
  showEl(catalogSentinel, !state.isSearchResults && state.catalog.length < state.catalogTotal && state.catalog.length > 0);
  if (!skipFocus) {
    const focusable = catalogGrid.querySelector(`[data-index="${state.selectedIndex}"]`);
    if (focusable) focusable.focus();
  }
}

function appendCatalogItems(startIndex) {
  if (!catalogGrid || startIndex >= state.catalog.length) return;
  for (let i = startIndex; i < state.catalog.length; i++) {
    catalogGrid.appendChild(createCatalogCard(state.catalog[i], i));
  }
  showEl(catalogSentinel, !state.isSearchResults && state.catalog.length < state.catalogTotal && state.catalog.length > 0);
}

function escapeAttr(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replace(/"/g, "&quot;");
}

function escapeHtml(s) {
  if (!s) return "";
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function openDetail(index) {
  state.selectedIndex = index;
  state.currentEpisode = null;
  const item = state.catalog[index];
  if (!item) return;
  const contentType = item.type || "movie";
  showEl(detailError, false);
  showEl(detailStreamError, false);
  showEl(detailContent, false);
  showEl(detailLoading, true);
  getMeta(item.id, contentType)
    .then((meta) => {
      if (!meta) {
        showEl(detailLoading, false);
        showEl(detailContent, false);
        showEl(streamPicker, false);
        showEl(streamsLoading, false);
        state.availableStreams = [];
        showEl(detailError, true);
        detailError.textContent = "Could not load details.";
        showView("detail");
        detailBack.focus();
        return;
      }
      showEl(detailLoading, false);
      showEl(detailError, false);
      state.currentItem = { ...item, ...meta };
      detailPoster.src = meta.poster || item.poster;
      detailPoster.alt = meta.name || item.title;
      detailTitle.textContent = meta.name || item.title;
      detailMeta.textContent = [meta.releaseInfo, meta.runtime].filter(Boolean).join(" · ") || "—";
      detailDescription.textContent = meta.description || "";
      if (detailEpisodes) {
        if (meta.videos && meta.videos.length > 0) {
          renderEpisodes(meta.videos);
          showEl(detailEpisodes, true);
        } else {
          detailEpisodes.innerHTML = "";
          showEl(detailEpisodes, false);
        }
      }
      showEl(detailContent, true);
      showEl(detailLoading, false);
      showEl(streamPicker, false);
      state.availableStreams = [];
      if ((contentType || "").toLowerCase() === "movie") {
        showEl(streamsLoading, true);
        showEl(playBtn, false);
        showEl(detailStreamError, false);
        loadStreamsForMovie(state.currentItem.id);
      } else {
        showEl(streamsLoading, false);
        showEl(playBtn, true);
      }
      showView("detail");
      detailBack.focus();
    })
    .catch(() => {
      showEl(detailLoading, false);
      showEl(detailContent, false);
      showEl(streamPicker, false);
      showEl(streamsLoading, false);
      state.availableStreams = [];
      showEl(detailError, true);
      detailError.textContent = "Network error. Is the backend running at " + API_BASE + "?";
      showView("detail");
      detailBack.focus();
    });
}

function loadStreamsForMovie(id) {
  getStreams(id, "movie")
    .then((result) => {
      const streams = (result.streams || []).filter((s) => s && s.url);
      showEl(streamsLoading, false);
      if (state.currentItem && (state.currentItem.type || "").toLowerCase() === "series") showEl(playBtn, true);
      if (streams.length === 0) {
        showEl(detailStreamError, true);
        detailStreamError.textContent = result.message || "No streams available. Try another title or add addons in Settings.";
        detailStreamError.classList.remove("error-message");
        detailStreamError.classList.add("stream-empty-message");
        return;
      }
      state.availableStreams = streams;
      showStreamPicker(streams, id, "movie");
      showEl(detailStreamError, false);
    })
    .catch(() => {
      showEl(streamsLoading, false);
      if (state.currentItem && (state.currentItem.type || "").toLowerCase() === "series") showEl(playBtn, true);
      showEl(detailStreamError, true);
      detailStreamError.textContent = "Could not load streams. Check backend.";
      detailStreamError.classList.add("error-message");
      detailStreamError.classList.remove("stream-empty-message");
    });
}

function renderAddonsList(addons) {
  if (!addonsList) return;
  addonsList.innerHTML = "";
  addons.forEach((a) => {
    const row = document.createElement("div");
    row.className = "addon-row";
    row.role = "listitem";
    const label = a.name || a.baseUrl || String(a.id);
    const shortUrl = a.baseUrl && a.baseUrl.length > 50 ? a.baseUrl.slice(0, 47) + "…" : a.baseUrl;
    row.innerHTML = `
      <div class="addon-info">
        <p class="name">${escapeHtml(label)}</p>
        ${a.baseUrl ? `<p class="url">${escapeHtml(shortUrl)}</p>` : ""}
      </div>
      <button type="button" class="addon-toggle" aria-pressed="${a.enabled}" aria-label="Toggle ${escapeAttr(label)}" data-id="${a.id}"> </button>
    `;
    const toggle = row.querySelector(".addon-toggle");
    toggle.addEventListener("click", () => {
      const next = !a.enabled;
      // Always persist on server (local or deployed); revert UI if save fails
      patchAddon(a.id, { enabled: next })
        .then((updated) => {
          if (updated) {
            a.enabled = updated.enabled;
            toggle.setAttribute("aria-pressed", updated.enabled);
          }
        })
        .catch(() => {
          toggle.setAttribute("aria-pressed", a.enabled);
          if (addonFormMessage) { showEl(addonFormMessage, true); addonFormMessage.textContent = "Could not save. Check backend."; }
        });
    });
    addonsList.appendChild(row);
  });
}

function renderSuggestedAddons() {
  if (!suggestedAddons) return;
  suggestedAddons.innerHTML = "";
  KNOWN_ADDONS.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "suggested-addon-btn";
    btn.textContent = item.name;
    btn.title = item.note || item.url;
    btn.addEventListener("click", () => {
      addonUrlInput.value = item.url;
      if (item.note) addonNameInput.value = item.name;
      addonUrlInput.focus();
    });
    suggestedAddons.appendChild(btn);
  });
}

function loadAddons() {
  showEl(addonsLoading, true);
  showEl(addonsError, false);
  getAddons()
    .then((list) => {
      state.addons = list;
      showEl(addonsLoading, false);
      renderAddonsList(list);
    })
    .catch(() => {
      showEl(addonsLoading, false);
      showEl(addonsError, true);
      addonsError.textContent = "Could not load addons. Check backend.";
    });
}

function openSettings() {
  showView("settings");
  renderSuggestedAddons();
  loadAddons();
  if (settingsBack) settingsBack.focus();
}

function renderEpisodes(videos) {
  if (!detailEpisodes) return;
  const bySeason = {};
  videos.forEach((v) => {
    const s = (v.season != null ? v.season : 0);
    if (!bySeason[s]) bySeason[s] = [];
    bySeason[s].push(v);
  });
  const seasons = Object.keys(bySeason).map(Number).sort((a, b) => a - b);
  detailEpisodes.innerHTML = "";
  const heading = document.createElement("h3");
  heading.className = "detail-episodes-heading";
  heading.textContent = "Episodes";
  detailEpisodes.appendChild(heading);
  const scrollWrap = document.createElement("div");
  scrollWrap.className = "detail-episodes-scroll";
  seasons.forEach((seasonNum) => {
    const seasonLabel = "Season " + seasonNum;
    const seasonBlock = document.createElement("div");
    seasonBlock.className = "detail-season-block";
    const seasonTitle = document.createElement("button");
    seasonTitle.type = "button";
    seasonTitle.className = "detail-season-title";
    seasonTitle.setAttribute("aria-expanded", "true");
    seasonTitle.textContent = seasonLabel;
    seasonTitle.innerHTML = seasonLabel + " <span class=\"detail-season-chevron\" aria-hidden=\"true\">▼</span>";
    const list = document.createElement("div");
    list.className = "detail-episodes-list";
    list.role = "list";
    bySeason[seasonNum].sort((a, b) => (a.episode != null ? a.episode : 0) - (b.episode != null ? b.episode : 0)).forEach((ep) => {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "detail-episode-row";
      row.role = "listitem";
      row.dataset.episodeId = ep.id;
      row.textContent = (ep.episode != null ? "E" + ep.episode + " " : "") + (ep.title || "Episode");
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        state.currentEpisode = { id: ep.id, title: ep.title };
        detailEpisodes.querySelectorAll(".detail-episode-row").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        playCurrent();
      });
      list.appendChild(row);
    });
    seasonTitle.addEventListener("click", () => {
      const expanded = seasonBlock.classList.toggle("collapsed");
      seasonTitle.setAttribute("aria-expanded", !expanded);
    });
    seasonBlock.appendChild(seasonTitle);
    seasonBlock.appendChild(list);
    scrollWrap.appendChild(seasonBlock);
  });
  detailEpisodes.appendChild(scrollWrap);
}

function playCurrent() {
  if (!state.currentItem) return;
  const isSeries = state.currentItem.type === "series";
  const playId = isSeries && state.currentEpisode ? state.currentEpisode.id : state.currentItem.id;
  const playType = isSeries && state.currentEpisode ? "series" : (state.currentItem.type || "movie");
  showEl(detailStreamError, false);
  if (isSeries && !state.currentEpisode) {
    showEl(detailStreamError, true);
    detailStreamError.textContent = "Select an episode above, then press Play.";
    detailStreamError.classList.remove("error-message");
    detailStreamError.classList.add("stream-empty-message");
    return;
  }
  if (!isSeries && state.availableStreams && state.availableStreams.length > 0) {
    showStreamPicker(state.availableStreams, playId, playType);
    return;
  }
  getStreams(playId, playType)
    .then((result) => {
      const streams = (result.streams || []).filter((s) => s && s.url);
      if (streams.length === 0) {
        showEl(detailStreamError, true);
        detailStreamError.textContent = result.message || "No streams available. Try another title or add addons in Settings.";
        detailStreamError.classList.remove("error-message");
        detailStreamError.classList.add("stream-empty-message");
        return;
      }
      if (isSeries) {
        startStreamWithPreview(streams[0], playId, playType);
        return;
      }
      state.availableStreams = streams;
      showStreamPicker(streams, playId, playType);
    })
    .catch((err) => {
      showEl(detailStreamError, true);
      detailStreamError.textContent = (err && err.hint) ? err.hint : (err && err.error) ? err.error : "Could not load stream. Check backend.";
      detailStreamError.classList.add("error-message");
      detailStreamError.classList.remove("stream-empty-message");
    });
}

const QUALITY_ORDER = ["4K", "1080p", "720p", "480p", "Other"];

function getStreamQualityGroup(stream) {
  const name = (stream.name || "").toLowerCase();
  if (/\b(2160p?|4k|uhd)\b/.test(name)) return "4K";
  if (/\b1080p?\b/.test(name)) return "1080p";
  if (/\b720p?\b/.test(name)) return "720p";
  if (/\b480p?\b/.test(name)) return "480p";
  return "Other";
}

function groupStreamsByQuality(streams) {
  const groups = { "4K": [], "1080p": [], "720p": [], "480p": [], "Other": [] };
  streams.forEach((s) => {
    const g = getStreamQualityGroup(s);
    if (groups[g]) groups[g].push(s);
    else groups.Other.push(s);
  });
  return QUALITY_ORDER.filter((q) => groups[q].length > 0).map((q) => ({ quality: q, streams: groups[q] }));
}

function showStreamPicker(streams, playIdParam, playTypeParam) {
  if (!streamPickerList || !streamPicker) return;
  streamPickerList.innerHTML = "";
  const grouped = groupStreamsByQuality(streams);
  let firstFocus = null;
  grouped.forEach(({ quality, streams: list }, groupIndex) => {
    const groupDiv = document.createElement("div");
    groupDiv.className = "stream-picker-group";
    const header = document.createElement("button");
    header.type = "button";
    header.className = "stream-picker-group-header";
    header.setAttribute("aria-expanded", groupIndex === 0);
    header.setAttribute("aria-controls", "stream-picker-group-" + groupIndex);
    header.textContent = quality + " (" + list.length + ")";
    const content = document.createElement("div");
    content.id = "stream-picker-group-" + groupIndex;
    content.className = "stream-picker-group-content" + (groupIndex === 0 ? "" : " collapsed");
    list.forEach((stream) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stream-picker-item";
      btn.textContent = stream.name || "Stream";
      btn.setAttribute("role", "listitem");
      btn.addEventListener("click", () => {
        showEl(streamPicker, false);
        startStreamWithPreview(stream, playIdParam, playTypeParam);
      });
      content.appendChild(btn);
      if (!firstFocus) firstFocus = btn;
    });
    header.addEventListener("click", () => {
      const expanded = content.classList.toggle("collapsed");
      header.setAttribute("aria-expanded", !expanded);
    });
    groupDiv.appendChild(header);
    groupDiv.appendChild(content);
    streamPickerList.appendChild(groupDiv);
  });
  showEl(streamPicker, true);
  if ((playTypeParam || "").toLowerCase() === "movie" && playBtn) showEl(playBtn, false);
  if (firstFocus) firstFocus.focus();
}

function playStream(url, _type, title) {
  const playingTitle = title || (state.currentItem && (state.currentItem.name || state.currentItem.title)) || "StremioPI";
  const mpvTitleEl = document.getElementById("mpv-playing-title");
  if (mpvTitleEl) mpvTitleEl.textContent = "▶ " + playingTitle;

  apiPost("/player/launch", { url, title: playingTitle })
    .then(() => {
      showView("player");
      const stopBtn = document.getElementById("player-close");
      if (stopBtn) stopBtn.focus();
    })
    .catch((err) => {
      showEl(detailStreamError, true);
      detailStreamError.textContent = "Could not launch MPV. Is mpv installed on the Pi? " + (err && err.message ? err.message : "");
      detailStreamError.classList.add("error-message");
    });
}

function destroyHls() { /* no-op: MPV handles playback */ }

function closePlayer() {
  // Stop MPV on the Pi
  apiPost("/player/stop", {}).catch(() => {});
  state.currentStream = null;
  showView("detail");
  if (state.currentItem && state.currentItem.type === "series" && playBtn) playBtn.focus();
  else if (detailBack) detailBack.focus();
}

function startStreamWithPreview(stream, id, type) {
  state.currentStream = stream;
  const title = state.currentItem && (state.currentItem.name || state.currentItem.title);
  playStream(stream.url, stream.type, title);
}

// ----- Keyboard navigation -----
const COLUMNS = 3;

function moveFocusList(direction) {
  const len = state.catalog.length;
  if (len === 0) return;
  const prevIndex = state.selectedIndex;
  if (direction === "left") state.selectedIndex = Math.max(0, state.selectedIndex - 1);
  else if (direction === "right") state.selectedIndex = Math.min(len - 1, state.selectedIndex + 1);
  else if (direction === "up") state.selectedIndex = Math.max(0, state.selectedIndex - COLUMNS);
  else if (direction === "down") state.selectedIndex = Math.min(len - 1, state.selectedIndex + COLUMNS);
  if (state.selectedIndex === prevIndex) return;
  const nextCard = catalogGrid && catalogGrid.querySelector(`[data-index="${state.selectedIndex}"]`);
  if (nextCard) {
    catalogGrid.querySelectorAll("[data-index]").forEach((el) => { el.tabIndex = parseInt(el.dataset.index, 10) === state.selectedIndex ? 0 : -1; });
    nextCard.focus();
  } else {
    renderList();
  }
}

function onKeyDown(e) {
  if (state.view === "player") {
    if (e.key === "Backspace" || e.key === "Escape" || e.key === "q" || e.key === "Q") {
      e.preventDefault();
      closePlayer();
    }
    return;
  }

  if (state.view === "detail") {
    if (e.key === "Backspace" || e.key === "Escape") {
      e.preventDefault();
      if (streamPicker && !streamPicker.classList.contains("hidden")) {
        showEl(streamPicker, false);
        state.availableStreams = [];
        if (state.currentItem && state.currentItem.type === "series" && playBtn) playBtn.focus();
        else if (detailBack) detailBack.focus();
      } else {
        showView("list");
        const focusable = catalogGrid.querySelector(`[data-index="${state.selectedIndex}"]`);
        if (focusable) focusable.focus();
      }
    }
    if (e.key === "Enter" && document.activeElement === playBtn) {
      e.preventDefault();
      playCurrent();
    }
    return;
  }

  if (state.view === "settings") {
    if (e.key === "Backspace" || e.key === "Escape") {
      e.preventDefault();
      showView("list");
      if (openSettingsBtn) openSettingsBtn.focus();
    }
    return;
  }

  if (state.view === "list") {
    if (e.key === "ArrowLeft") { e.preventDefault(); moveFocusList("left"); }
    else if (e.key === "ArrowRight") { e.preventDefault(); moveFocusList("right"); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveFocusList("up"); }
    else if (e.key === "ArrowDown") { e.preventDefault(); moveFocusList("down"); }
    else if (e.key === "Enter") {
      e.preventDefault();
      openDetail(state.selectedIndex);
    }
  }
}

// ----- Clicks -----
detailBack.addEventListener("click", () => {
  showView("list");
  const focusable = catalogGrid.querySelector(`[data-index="${state.selectedIndex}"]`);
  if (focusable) focusable.focus();
});

if (openSettingsBtn) openSettingsBtn.addEventListener("click", openSettings);

if (settingsBack) settingsBack.addEventListener("click", () => { showView("list"); if (openSettingsBtn) openSettingsBtn.focus(); });

if (addonAddBtn) addonAddBtn.addEventListener("click", () => {
  const url = (addonUrlInput && addonUrlInput.value) ? addonUrlInput.value.trim() : "";
  const name = (addonNameInput && addonNameInput.value) ? addonNameInput.value.trim() : null;
  showEl(addonFormMessage, false);
  if (!url) {
    showEl(addonFormMessage, true);
    if (addonFormMessage) addonFormMessage.textContent = "Enter addon URL.";
    return;
  }
  // Persist on server (same backend whether app runs locally or on server)
  addAddon(url, name || null)
    .then((added) => {
      if (addonUrlInput) addonUrlInput.value = "";
      if (addonNameInput) addonNameInput.value = "";
      state.addons = state.addons.concat([added]);
      renderAddonsList(state.addons);
      showEl(addonFormMessage, false);
    })
    .catch(() => {
      showEl(addonFormMessage, true);
      if (addonFormMessage) addonFormMessage.textContent = "Failed to add. Check URL or duplicate.";
    });
});

playBtn.addEventListener("click", () => playCurrent());

playerClose.addEventListener("click", closePlayer);

function setCatalogTabActive(type) {
  [tabAll, tabMovies, tabSeries].forEach((btn) => {
    if (!btn) return;
    const isActive = (btn.dataset.type || "") === type;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function populateCatalogSelect() {
  if (!catalogSelect) return;
  const type = state.catalogType;
  catalogSelect.innerHTML = "";
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All catalogs";
  catalogSelect.appendChild(all);
  const list = type === "series" ? state.catalogOptions.series : type === "movie" ? state.catalogOptions.movie : [...state.catalogOptions.movie, ...state.catalogOptions.series];
  list.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c.id;
    opt.textContent = c.name || c.id;
    if (state.catalogId === c.id) opt.selected = true;
    catalogSelect.appendChild(opt);
  });
  if (state.catalogId && !list.some((c) => c.id === state.catalogId)) state.catalogId = "";
}

function runSearch() {
  const q = searchInput ? String(searchInput.value || "").trim() : "";
  const type = state.catalogType === "series" ? "series" : "movie";
  if (!q) {
    state.isSearchResults = false;
    loadCatalogByType(state.catalogType);
    return;
  }
  state.searchQuery = q;
  state.selectedIndex = 0;
  showEl(catalogLoading, true);
  showEl(catalogError, false);
  showEl(document.getElementById("catalog-scroll"), false);
  searchCatalog(type, q).then((data) => {
    showEl(catalogLoading, false);
    showEl(catalogError, false);
    state.catalog = data.items || [];
    state.catalogTotal = data.total != null ? data.total : 0;
    state.isSearchResults = true;
    showEl(document.getElementById("catalog-scroll"), true);
    renderList();
    showEl(catalogSentinel, false);
    announce("Search results");
  }).catch((err) => {
    showEl(catalogLoading, false);
    showEl(document.getElementById("catalog-scroll"), false);
    showEl(catalogErrorWrap, true);
    catalogError.textContent = (err && err.message) === "Request timed out" ? "Search timed out. Addons may be slow or unreachable." : "Search failed.";
  });
}

function loadCatalogByType(type) {
  state.catalogType = type;
  state.selectedIndex = 0;
  state.catalogTotal = 0;
  state.isSearchResults = false;
  setCatalogTabActive(type);
  const load = () => {
    const isFirstLoad = state.catalog.length === 0;
    if (isFirstLoad) {
      showEl(catalogLoading, true);
      showEl(document.getElementById("catalog-scroll"), false);
    }
    showEl(catalogErrorWrap, false);
    getCatalog(type, 0, CATALOG_PAGE_SIZE, state.catalogId || undefined)
      .then((data) => {
        showEl(catalogLoading, false);
        showEl(catalogErrorWrap, false);
        state.catalog = data.items || [];
        state.catalogTotal = data.total != null ? data.total : 0;
        showEl(document.getElementById("catalog-scroll"), true);
        renderList();
        showEl(catalogLoading, false);
        if (state.view !== "list") showView("list");
        announce(type === "all" ? "All" : type === "movie" ? "Movies" : "Series");
      })
      .catch((err) => {
        showEl(catalogLoading, false);
        showEl(document.getElementById("catalog-scroll"), false);
        showEl(catalogError, true);
        const isLocal = API_BASE.includes("localhost") || API_BASE.includes("127.0.0.1");
        const msg = isLocal
          ? "Could not load catalog. Start the backend first: cd backend && npm start."
          : "Could not load catalog. Check backend is running and reachable.";
        catalogError.textContent = (err && err.message) === "Request timed out" ? "Catalog request timed out. Is the backend running?" : msg;
      });
  };
  getCatalogOptions().then((opts) => {
    state.catalogOptions = opts;
    populateCatalogSelect();
    load();
  }).catch(() => load());
}

function loadMore() {
  if (state.isSearchResults || state.catalog.length >= state.catalogTotal || state.catalogLoadingMore) return;
  state.catalogLoadingMore = true;
  const previousLength = state.catalog.length;
  const scrollEl = catalogScroll;
  const savedScrollTop = scrollEl ? scrollEl.scrollTop : 0;
  getCatalog(state.catalogType, previousLength, CATALOG_PAGE_SIZE, state.catalogId || undefined)
    .then((data) => {
      const next = data.items || [];
      state.catalog = state.catalog.concat(next);
      state.catalogTotal = data.total != null ? data.total : state.catalog.length;
      state.catalogLoadingMore = false;
      appendCatalogItems(previousLength);
      if (scrollEl) {
        function restoreScroll() {
          scrollEl.scrollTop = savedScrollTop;
        }
        requestAnimationFrame(() => {
          restoreScroll();
          requestAnimationFrame(restoreScroll);
        });
        setTimeout(restoreScroll, 50);
      }
    })
    .catch(() => {
      state.catalogLoadingMore = false;
    });
}

// ----- Init -----
document.addEventListener("keydown", onKeyDown);

if (catalogTabs) {
  catalogTabs.querySelectorAll(".catalog-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const type = btn.dataset.type || "all";
      if (type === state.catalogType) return;
      state.catalogId = "";
      loadCatalogByType(type);
    });
  });
}
if (catalogSelect) {
  catalogSelect.addEventListener("change", () => {
    state.catalogId = catalogSelect.value || "";
    loadCatalogByType(state.catalogType);
  });
}
if (searchBtn) searchBtn.addEventListener("click", () => runSearch());
if (searchInput) {
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") runSearch(); });
}
if (catalogSentinel && catalogScroll) {
  const observer = new IntersectionObserver(
    (entries) => {
      const entry = entries[0];
      if (!entry || !entry.isIntersecting) return;
      if (state.catalog.length < state.catalogTotal && state.catalog.length > 0 && !state.catalogLoadingMore && !state.isSearchResults) loadMore();
    },
    { root: catalogScroll, rootMargin: "600px 0px", threshold: 0 }
  );
  observer.observe(catalogSentinel);
  catalogScroll.addEventListener("scroll", function onCatalogScroll() {
    if (state.isSearchResults || state.catalog.length >= state.catalogTotal || state.catalogLoadingMore) return;
    const nearBottom = catalogScroll.scrollHeight - catalogScroll.scrollTop - catalogScroll.clientHeight < 400;
    if (nearBottom && state.catalog.length > 0) loadMore();
  });
}

showEl(catalogError, false);
showEl(document.getElementById("catalog-scroll"), false);
loadCatalogByType(state.catalogType);
