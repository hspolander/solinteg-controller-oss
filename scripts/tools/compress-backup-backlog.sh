#!/usr/bin/env bash
# ONE-TIME migration: gzip the snapshots that were written before backup.py started compressing.
#
#   sudo -u solinteg bash /opt/solinteg/app/scripts/tools/compress-backup-backlog.sh
#   sudo -u solinteg bash .../compress-backup-backlog.sh --dry-run
#
# Run as the `solinteg` user — it owns /opt/solinteg/backups, and the login user cannot even list
# it. (That is why an earlier attempt to do this with a bare `gzip /opt/solinteg/backups/*.db`
# failed with "No such file or directory": the glob never expanded, so the literal string was
# passed to gzip.)
#
# WHY THIS EXISTS. backup.py started gzipping on 2026-09-03, which takes a snapshot from ~367 MB
# to ~43 MB — a 8.4x cut. But it only compresses the snapshot it writes THAT night, so the
# existing ~20 uncompressed ones convert at one per night as rotation reaches them: three weeks
# during which the offsite bucket stays several gigabytes larger than it needs to be. On the
# reference deployment that was the difference between 6.3 GB and ~0.9 GB of current files, with
# a 10 GB cap already exceeded. This does the conversion in one pass instead.
#
# SAFETY. The original is removed only after the compressed copy passes `gzip -t`, which verifies
# the CRC32 that gzip stored over the ORIGINAL bytes — if that matches, decompression reproduces
# the input exactly. The uncompressed length is checked against the original file size as a second
# independent signal. Anything that fails either check keeps its original and is reported; the
# script does not stop, so one bad file cannot strand the other nineteen.
#
# Nothing else needs changing: backup.py's rotation glob is `telemetry-*.db*`, which matches both
# naming schemes as one chronological list (pinned by scripts/tests/test_backup.py), so a
# half-converted directory rotates correctly either way.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/solinteg/backups}"
DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

[ -d "$BACKUP_DIR" ] || { echo "no such directory: $BACKUP_DIR" >&2; exit 1; }
[ -w "$BACKUP_DIR" ] || { echo "cannot write to $BACKUP_DIR — run as the solinteg user" >&2; exit 1; }

shopt -s nullglob
# Exact `.db` suffix, so already-compressed snapshots are not matched. partial-* intermediates are
# not matched either — they are not snapshots and backup.py clears them on its next run.
files=("$BACKUP_DIR"/telemetry-*.db)

if [ ${#files[@]} -eq 0 ]; then
  echo "nothing to do — no uncompressed snapshots in $BACKUP_DIR"
  exit 0
fi

echo "Found ${#files[@]} uncompressed snapshot(s) in $BACKUP_DIR"
echo

before=$(du -sb "$BACKUP_DIR" | cut -f1)
converted=0
skipped=0
failed=0

for f in "${files[@]}"; do
  name=$(basename "$f")
  gz="$f.gz"

  # A backup that is mid-write must not be touched. backup.py writes to partial-* and renames,
  # so this should never trigger — it costs nothing and removes the question.
  if [ -n "$(find "$f" -mmin -10 2>/dev/null)" ]; then
    echo "  SKIP  $name (modified in the last 10 minutes)"
    skipped=$((skipped + 1))
    continue
  fi
  if [ -e "$gz" ]; then
    echo "  SKIP  $name ($(basename "$gz") already exists)"
    skipped=$((skipped + 1))
    continue
  fi

  orig_bytes=$(stat -c %s "$f")
  if [ "$DRY_RUN" = "1" ]; then
    printf '  would compress %s (%.0f MB)\n' "$name" "$(echo "$orig_bytes" | awk '{print $1/1e6}')"
    continue
  fi

  printf '  %s (%.0f MB) ... ' "$name" "$(echo "$orig_bytes" | awk '{print $1/1e6}')"
  if ! gzip -c -6 "$f" > "$gz.tmp" 2>/dev/null; then
    echo "FAILED to compress — original kept"
    rm -f "$gz.tmp"
    failed=$((failed + 1))
    continue
  fi

  # Integrity gate. gzip -t recomputes the CRC32 of the decompressed stream and compares it with
  # the one gzip recorded over the original input, so a pass means the bytes round-trip exactly.
  if ! gzip -t "$gz.tmp" 2>/dev/null; then
    echo "FAILED CRC check — original kept"
    rm -f "$gz.tmp"
    failed=$((failed + 1))
    continue
  fi

  # Second, independent check: the length gzip recorded must equal the file we read.
  unz_bytes=$(gzip -l "$gz.tmp" 2>/dev/null | awk 'NR==2 {print $2}')
  if [ "$unz_bytes" != "$orig_bytes" ]; then
    echo "FAILED size check ($unz_bytes != $orig_bytes) — original kept"
    rm -f "$gz.tmp"
    failed=$((failed + 1))
    continue
  fi

  mv "$gz.tmp" "$gz"
  # Keep the original's timestamps. Nothing depends on them (the filename carries the date), but
  # a backup directory where mtime says "all written today" is misleading to a human reading it.
  touch -r "$f" "$gz"
  rm -f "$f"
  new_bytes=$(stat -c %s "$gz")
  printf 'ok -> %.0f MB (%.0f%%)\n' \
    "$(echo "$new_bytes" | awk '{print $1/1e6}')" \
    "$(echo "$new_bytes $orig_bytes" | awk '{print $1/$2*100}')"
  converted=$((converted + 1))
done

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "dry run — nothing was changed"
  exit 0
fi

after=$(du -sb "$BACKUP_DIR" | cut -f1)
echo "converted $converted, skipped $skipped, failed $failed"
echo "$BACKUP_DIR: $(echo "$before" | awk '{printf "%.2f", $1/1e9}') GB -> $(echo "$after" | awk '{printf "%.2f", $1/1e9}') GB"
echo
echo "Next: the offsite mirror still has the OLD, larger files. It will not remove them on its"
echo "own while the destination is over its storage cap — rclone skips deletions when a run had"
echo "transfer errors, which is exactly what an over-cap upload is. Break that with one run that"
echo "deletes before it uploads:"
echo
echo "  sudo systemd-run --collect --wait --pipe --uid=solinteg \\"
echo "    -p EnvironmentFile=/opt/solinteg/solinteg.env -E RCLONE_DELETE_BEFORE=1 \\"
echo "    /opt/solinteg/app/.venv/bin/python /opt/solinteg/app/scripts/services/backup_offsite.py"

[ "$failed" -eq 0 ]
