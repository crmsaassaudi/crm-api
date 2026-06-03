#!/usr/bin/env bash
#
# Sample the CRM worker process RSS while a load test runs, so you can confirm
# the streaming pipeline keeps heap under the 500MB KPI.
#
# Usage:
#   ./monitor-worker-memory.sh                  # auto-detect "dist/worker" process
#   PATTERN="entryFile worker" ./monitor-worker-memory.sh
#   PID=12345 ./monitor-worker-memory.sh
#   INTERVAL=1 OUT=/tmp/worker-mem.csv ./monitor-worker-memory.sh
#
# Stop with Ctrl-C; it prints the peak RSS on exit.
set -euo pipefail

INTERVAL="${INTERVAL:-2}"
PATTERN="${PATTERN:-dist/worker}"
OUT="${OUT:-worker-memory.csv}"

if [[ -n "${PID:-}" ]]; then
  WORKER_PID="$PID"
else
  # Newest matching node process, excluding this script and grep itself.
  WORKER_PID="$(pgrep -fn "$PATTERN" || true)"
fi

if [[ -z "${WORKER_PID:-}" ]]; then
  echo "Could not find a worker process matching '$PATTERN'." >&2
  echo "Pass PID=<pid> or PATTERN=<substring> explicitly." >&2
  exit 1
fi

echo "Monitoring PID $WORKER_PID every ${INTERVAL}s → $OUT (Ctrl-C to stop)"
echo "timestamp,rss_mb,cpu_pct" > "$OUT"

PEAK=0
trap 'echo; echo "Peak RSS: ${PEAK} MB"; exit 0' INT TERM

while kill -0 "$WORKER_PID" 2>/dev/null; do
  # rss is in KB on Linux ps; %cpu is instantaneous.
  read -r RSS_KB CPU < <(ps -o rss=,%cpu= -p "$WORKER_PID" | awk '{print $1, $2}')
  RSS_MB=$(( RSS_KB / 1024 ))
  TS="$(date +%H:%M:%S)"
  echo "${TS},${RSS_MB},${CPU}" >> "$OUT"
  if (( RSS_MB > PEAK )); then PEAK=$RSS_MB; fi
  printf "\r  %s  RSS=%4d MB  CPU=%s%%  peak=%d MB   " "$TS" "$RSS_MB" "$CPU" "$PEAK"
  sleep "$INTERVAL"
done

echo
echo "Worker process exited. Peak RSS: ${PEAK} MB"
