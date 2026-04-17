/**
 * Download service — fetches a stream URL to disk with progress callbacks.
 * Downloads go to backend/downloads/ (configurable via DOWNLOADS_DIR env var).
 */
import { createWriteStream, existsSync, mkdirSync, unlinkSync } from "fs";
import { join, dirname, resolve, sep } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DOWNLOADS_DIR =
  process.env.DOWNLOADS_DIR || join(__dirname, "../../../downloads");

if (!existsSync(DOWNLOADS_DIR)) mkdirSync(DOWNLOADS_DIR, { recursive: true });

const clean = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 50);

/** Sanitize title + id to a safe .mp4 filename and return the resolved dest path */
export function safeFilename(title, id) {
  const dest = resolve(DOWNLOADS_DIR, `${clean(title)}__${clean(id)}.mp4`);
  if (!dest.startsWith(resolve(DOWNLOADS_DIR) + sep)) throw new Error("Path traversal");
  return dest;
}

/**
 * Download `url` to `destPath`, calling `onProgress(downloaded, total)` periodically.
 * Pass an AbortController.signal to support cancellation.
 * Returns destPath on success.
 */
export async function downloadFile(url, destPath, { onProgress, signal } = {}) {
  const res = await fetch(url, {
    headers: { "User-Agent": "ElectroBot/1.0" },
    signal,
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} — server odbio zahtjev`);

  const total = parseInt(res.headers.get("content-length") || "0", 10);
  let downloaded = 0;

  const fileStream = createWriteStream(destPath);

  try {
    for await (const chunk of res.body) {
      if (signal?.aborted) throw new Error("aborted");
      fileStream.write(chunk);
      downloaded += chunk.length;
      onProgress?.(downloaded, total);
    }
  } catch (err) {
    fileStream.destroy();
    try { unlinkSync(destPath); } catch {}
    throw err.message === "aborted" ? new Error("Preuzimanje otkazano.") : err;
  }

  await new Promise((resolve, reject) =>
    fileStream.end((e) => (e ? reject(e) : resolve()))
  );

  return destPath;
}
