import "dotenv/config";
import app from "./app.js";

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`StremioPI API running at http://localhost:${PORT}`);
  console.log(`  Health:  GET  http://localhost:${PORT}/health`);
  console.log(`  Catalog: GET  http://localhost:${PORT}/catalog`);
  console.log(`  Stream:  GET  http://localhost:${PORT}/stream/:id`);
  console.log(`  Player:  POST http://localhost:${PORT}/player/launch`);
});
