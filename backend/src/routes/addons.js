import { Router } from "express";
import { getAllAddons, getEnabledAddons, addAddon, updateAddon, deleteAddon } from "../services/addonStore.js";

const router = Router();

/**
 * GET /addons – list all addons (id, baseUrl, name, enabled)
 */
router.get("/", (req, res) => {
  const addons = getAllAddons();
  res.json({ addons });
});

/**
 * POST /addons – add addon. Body: { baseUrl, name? }
 */
router.post("/", (req, res) => {
  const { baseUrl, name } = req.body || {};
  if (!baseUrl || typeof baseUrl !== "string" || !baseUrl.trim()) {
    return res.status(400).json({ error: "baseUrl is required" });
  }
  const result = addAddon(baseUrl.trim(), name != null ? String(name) : null);
  if (!result) {
    return res.status(409).json({ error: "Addon with this URL already exists" });
  }
  res.status(201).json(result);
});

/**
 * PATCH /addons/:id – update addon. Body: { enabled?, name? }
 */
router.patch("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const { enabled, name } = req.body || {};
  const result = updateAddon(id, { enabled, name });
  if (!result) {
    return res.status(404).json({ error: "Addon not found" });
  }
  res.json(result);
});

/**
 * DELETE /addons/:id – remove addon
 */
router.delete("/:id", (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) {
    return res.status(400).json({ error: "Invalid id" });
  }
  const ok = deleteAddon(id);
  if (!ok) {
    return res.status(404).json({ error: "Addon not found" });
  }
  res.status(204).send();
});

export default router;
