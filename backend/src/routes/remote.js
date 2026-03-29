/**
 * TV remote events via SSE + CEC bridge
 * GET  /remote/events   — SSE stream of { key } events
 * POST /remote/key      — { key } posted by CEC script
 */
import { Router } from "express";

const router = Router();
const clients = new Set();

// POST /remote/key  { key: "ArrowUp" | "ArrowDown" | ... }
router.post("/key", (req, res) => {
  const { key } = req.body || {};
  if (!key) return res.status(400).json({ error: "key required" });
  for (const client of clients) {
    client.write(`data: ${JSON.stringify({ key })}\n\n`);
  }
  res.json({ ok: true, clients: clients.size });
});

// GET /remote/events  — SSE
router.get("/events", (req, res) => {
  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();
  res.write(": connected\n\n");

  clients.add(res);
  req.on("close", () => clients.delete(res));
});

export default router;
