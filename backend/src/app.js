import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import cors from "cors";
import catalogRoutes from "./routes/catalog.js";
import metaRoutes from "./routes/meta.js";
import streamRoutes from "./routes/stream.js";
import subtitlesRoutes from "./routes/subtitles.js";
import healthRoutes from "./routes/health.js";
import addonsRoutes from "./routes/addons.js";
import searchRoutes from "./routes/search.js";
import playerRoutes from "./routes/player.js";
import youtubeRoutes from "./routes/youtube.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(cors({ origin: true }));
app.use(express.json());

app.use("/catalog", catalogRoutes);
app.use("/meta", metaRoutes);
app.use("/stream", streamRoutes);
app.use("/subtitles", subtitlesRoutes);
app.use("/health", healthRoutes);
app.use("/addons", addonsRoutes);
app.use("/search", searchRoutes);
app.use("/player", playerRoutes);
app.use("/youtube", youtubeRoutes);

// Serve TV app static files
const tvAppDir = path.join(__dirname, "../../tv-app");
if (fs.existsSync(tvAppDir)) {
  app.use(express.static(tvAppDir, { index: false }));
  app.get("*", (req, res) => {
    res.sendFile(path.join(tvAppDir, "index.html"), (err) => {
      if (err) res.status(404).json({ error: "Not found" });
    });
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});

export default app;
