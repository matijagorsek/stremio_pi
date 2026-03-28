import { Router } from "express";
const router = Router();
router.get("/", (_req, res) => {
  res.json({ status: "ok", service: "stremio-pi-backend", timestamp: new Date().toISOString() });
});
export default router;
