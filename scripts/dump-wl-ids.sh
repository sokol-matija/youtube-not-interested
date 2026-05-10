#!/usr/bin/env bash
# Dump Watch Later video IDs via yt-dlp + Chrome cookies, copy to clipboard.
# Usage: ./scripts/dump-wl-ids.sh

set -e

if ! command -v yt-dlp >/dev/null 2>&1; then
    echo "yt-dlp not installed. brew install yt-dlp" >&2
    exit 1
fi

OUT=$(yt-dlp --flat-playlist --print "%(id)s" \
    --cookies-from-browser chrome \
    "https://www.youtube.com/playlist?list=WL")

COUNT=$(echo "$OUT" | wc -l | tr -d ' ')
echo "$OUT" | pbcopy

echo "Dumped $COUNT video IDs."
echo "Copied to clipboard."
echo "Open extension popup → 'Import IDs' → paste → Save."
