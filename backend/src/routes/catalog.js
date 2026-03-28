import { Router } from "express";
import { catalog as catalogData } from "../data/mockData.js";
import { getEnabledAddons } from "../services/addonStore.js";
import { getAddonCatalog, getCatalogOptions } from "../services/addonClient.js";

const router = Router();

/** GET /catalog/options - list of catalog dropdown options per type (from addon manifests) */
router.get("/options", async (_req, res) => {
  const enabled = getEnabledAddons();
  const options = await getCatalogOptions(enabled);
  res.json(options);
});

/**
 * GET /catalog
 * Query: type (optional), catalogId (optional), limit (optional), offset (optional)
 * catalogId: when set, only that catalog is fetched; when empty, all catalogs for the type are merged.
 */
router.get("/", async (req, res) => {
  const { type, catalogId, limit = 20, offset = 0 } = req.query;
  const catalogType = type === "series" ? "series" : type === "movie" ? "movie" : "all";
  const singleCatalogId = catalogId && String(catalogId).trim() ? String(catalogId).trim() : null;
  const enabled = getEnabledAddons();
  let items;

  if (enabled.length > 0) {
    if (catalogType === "all") {
      const [movies, series] = await Promise.all([
        getAddonCatalog(enabled, "movie", singleCatalogId),
        getAddonCatalog(enabled, "series", singleCatalogId),
      ]);
      const byId = new Map();
      [...(movies || []), ...(series || [])].forEach((item) => {
        if (item && item.id && !byId.has(item.id)) byId.set(item.id, item);
      });
      items = Array.from(byId.values());
    } else {
      items = await getAddonCatalog(enabled, catalogType, singleCatalogId);
    }
  } else {
    items = [...catalogData];
  }

  if (catalogType === "movie" || catalogType === "series") {
    items = items.filter((item) => item.type === catalogType);
  }

  const total = items.length;
  const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 20), 100);
  const offsetNum = Math.max(0, parseInt(offset, 10) || 0);
  const list = items.slice(offsetNum, offsetNum + limitNum);

  res.json({
    total,
    limit: limitNum,
    offset: offsetNum,
    items: list,
  });
});

export default router;
