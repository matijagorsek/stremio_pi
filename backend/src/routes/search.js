import { Router } from "express";
import { getEnabledAddons } from "../services/addonStore.js";
import { getAddonSearch } from "../services/addonClient.js";

const router = Router();

/**
 * GET /search?type=movie|series&q=...
 * Returns catalog items matching the query from enabled addons (Stremio catalog search).
 */
router.get("/", async (req, res) => {
  const { type, q } = req.query;
  const catalogType = type === "series" ? "series" : "movie";
  const enabled = getEnabledAddons();
  if (enabled.length === 0) return res.json({ items: [], total: 0 });
  const items = await getAddonSearch(enabled, catalogType, q || "");
  res.json({ items, total: items.length });
});

export default router;
