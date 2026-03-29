/**
 * Voice transcription route
 * POST /voice/transcribe  multipart: field "audio" (webm/opus from browser)
 * Returns { text }
 */
import { Router }   from "express";
import { spawn }    from "child_process";
import multer       from "multer";
import fs           from "fs";
import path         from "path";
import os           from "os";

const router = Router();
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 10 * 1024 * 1024 } });

function transcribe(audioPath) {
  return new Promise((resolve, reject) => {
    const script = `
import sys
from faster_whisper import WhisperModel
model = WhisperModel("base", device="cpu", compute_type="int8")
segments, _ = model.transcribe(sys.argv[1], language="hr", beam_size=3)
print(" ".join(s.text for s in segments).strip())
`;
    const proc = spawn("python3", ["-c", script, audioPath]);
    let out = "", err = "";
    proc.stdout.on("data", d => { out += d; });
    proc.stderr.on("data", d => { err += d; });
    proc.on("close", code => {
      if (code !== 0) reject(new Error(err.slice(-200) || `whisper exited ${code}`));
      else resolve(out.trim());
    });
    proc.on("error", e => reject(new Error(`python3: ${e.message}`)));
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("Transcription timeout")); }, 30000);
  });
}

function convertToWav(input, output) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", ["-y", "-i", input, "-ar", "16000", "-ac", "1", "-f", "wav", output]);
    proc.on("close", code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
    proc.on("error", e => reject(new Error(`ffmpeg: ${e.message}`)));
    setTimeout(() => { try { proc.kill(); } catch {} reject(new Error("ffmpeg timeout")); }, 15000);
  });
}

router.post("/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file" });

  const wavPath = req.file.path + ".wav";
  try {
    await convertToWav(req.file.path, wavPath);
    const text = await transcribe(wavPath);
    res.json({ text });
  } catch (err) {
    console.error("[Voice] transcribe error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    for (const p of [req.file.path, wavPath]) {
      fs.unlink(p, () => {});
    }
  }
});

export default router;
