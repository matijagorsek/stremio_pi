#!/bin/bash
# StremioPI Kiosk launcher
# Starts the backend (pm2) and opens Chromium in fullscreen kiosk mode

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

echo "🎬 Starting StremioPI..."

# Start backend via pm2 if not running
if ! pm2 list | grep -q "stremio-pi"; then
  echo "📡 Starting backend..."
  cd "$ROOT_DIR"
  pm2 start ecosystem.config.cjs
  sleep 2
fi

# Wait for backend to be ready
echo "⏳ Waiting for backend..."
for i in $(seq 1 10); do
  if curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "✅ Backend ready"
    break
  fi
  sleep 1
done

# Launch Chromium in kiosk mode
echo "🌐 Launching Chromium kiosk..."
chromium-browser \
  --kiosk \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-restore-session-state \
  --autoplay-policy=no-user-gesture-required \
  "http://localhost:3000" \
  2>/dev/null &

echo "✅ StremioPI launched! Visit http://localhost:3000"
