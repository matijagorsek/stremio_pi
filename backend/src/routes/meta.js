import { Router } from "express";
import { meta as metaData } from "../data/mockData.js";
import { getEnabledAddons } from "../services/addonStore.js";
import { getAddonMeta } from "../services/addonClient.js";

const router = Router();

/** Allow safe id chars (alphanumeric, underscore, colon, dot for e.g. tt1234567) */
const ID_REGEX = /^[a-zA-Z0-9_.:-]+$/;

/**
 * GET /meta/:id?type=movie|series
 * When addons are enabled, meta is loaded from first addon that has it; otherwise mock data.
 * For series, meta includes videos (episodes) when the addon provides them.
 */
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  const type = req.query.type === "series" ? "series" : "movie";
  if (!id || !ID_REGEX.test(id)) {
    return res.status(400).json({ error: "Invalid id", id: id || "" });
  }

  const enabled = getEnabledAddons();
  let item;
  if (enabled.length > 0) {
    item = await getAddonMeta(enabled, type, id);
  } else {
    item = metaData[id];
  }

  if (!item) {
    return res.status(404).json({
      error: "Not found",
      id,
      message: "No addon returned meta for this id. Try another addon that supports this catalog (e.g. TMDB addon for tmdb: ids).",
    });
  }

  res.json(item);
});

export default router;
