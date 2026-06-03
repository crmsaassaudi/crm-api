#!/usr/bin/env bash
#
# Monitor the CRM worker (and host) during a contact-import load test, then
# write a report. Linux server (uses ps / free / uptime).
#
# Usage:
#   ./monitor-server.sh                         # auto-detect "dist/worker", run until Ctrl-C
#   DURATION=300 ./monitor-server.sh            # auto-stop after 300s
#   PID=12345 ./monitor-server.sh               # monitor a specific PID
#   WORKER_PATTERN="entryFile worker" ./monitor-server.sh
#   INTERVAL=1 KPI_MB=500 OUT_DIR=./loadtest-report ./monitor-server.sh
#
# Produces in OUT_DIR:
#   samples.csv   timestamp,elapsed_s,worker_rss_mb,worker_cpu_pct,sys_mem_used_mb,load1
#   report.md     summary (peak/avg RSS, peak CPU, KPI PASS/FAIL)
#
set -uo pipefail

INTERVAL="${INTERVAL:-2}"
DURATION="${DURATION:-0}"          # 0 = until Ctrl-C or worker exits
WORKER_PATTERN="${WORKER_PATTERN:-dist/worker}"
KPI_MB="${KPI_MB:-500}"
OUT_DIR="${OUT_DIR:-./loadtest-report}"

mkdir -p "$OUT_DIR"
CSV="$OUT_DIR/samples.csv"
REPORT="$OUT_DIR/report.md"

# ── Resolve worker PID ────────────────────────────────────────────────
if [[ -n "${PID:-}" ]]; then
  WORKER_PID="$PID"
else
  WORKER_PID="$(pgrep -fn "$WORKER_PATTERN" || true)"
fi
if [[ -z "${WORKER_PID:-}" ]]; then
  echo "ERROR: no worker process matching '$WORKER_PATTERN'." >&2
  echo "Pass PID=<pid> or WORKER_PATTERN=<substring>." >&2
  exit 1
fi

echo "timestamp,elapsed_s,worker_rss_mb,worker_cpu_pct,sys_mem_used_mb,load1" > "$CSV"

START=$(date +%s)
PEAK_RSS=0
SUM_RSS=0
PEAK_CPU=0
SUM_CPU=0
SAMPLES=0

write_report() {
  local END elapsed avg_rss avg_cpu kpi
  END=$(date +%s)
  elapsed=$(( END - START ))
  if (( SAMPLES > 0 )); then
    avg_rss=$(awk "BEGIN{printf \"%.0f\", $SUM_RSS/$SAMPLES}")
    avg_cpu=$(awk "BEGIN{printf \"%.1f\", $SUM_CPU/$SAMPLES}")
  else
    avg_rss=0; avg_cpu=0
  fi
  if (( PEAK_RSS <= KPI_MB )); then kpi="PASS ✅"; else kpi="FAIL ❌"; fi

  {
    echo "# Contact Import — Server Monitor Report"
    echo
    echo "- Generated : $(date '+%Y-%m-%d %H:%M:%S')"
    echo "- Worker PID: $WORKER_PID (\`$WORKER_PATTERN\`)"
    echo "- Duration  : ${elapsed}s over ${SAMPLES} samples (every ${INTERVAL}s)"
    echo
    echo "## Worker memory (heap RSS)"
    echo
    echo "| Metric | Value | KPI |"
    echo "| ------ | ----- | --- |"
    echo "| Peak RSS | ${PEAK_RSS} MB | ≤ ${KPI_MB} MB → ${kpi} |"
    echo "| Avg RSS  | ${avg_rss} MB | — |"
    echo "| Peak CPU | ${PEAK_CPU}% | — |"
    echo "| Avg CPU  | ${avg_cpu}% | — |"
    echo
    echo "## Notes"
    echo
    echo "- A flat RSS curve regardless of file size = streaming pipeline OK."
    echo "- RSS growing linearly with rows = suspected leak (stream not released"
    echo "  or in-memory error accumulation)."
    echo "- Raw samples: \`samples.csv\` (import into a sheet to chart over time)."
  } > "$REPORT"

  echo
  echo "──────────────── Summary ────────────────"
  echo "  samples   : $SAMPLES   duration: ${elapsed}s"
  echo "  peak RSS  : ${PEAK_RSS} MB   (KPI ≤ ${KPI_MB} MB → ${kpi})"
  echo "  avg  RSS  : ${avg_rss} MB"
  echo "  peak CPU  : ${PEAK_CPU}%   avg CPU: ${avg_cpu}%"
  echo "  report    : $REPORT"
  echo "  samples   : $CSV"
}

trap 'write_report; exit 0' INT TERM

echo "Monitoring worker PID $WORKER_PID every ${INTERVAL}s → $OUT_DIR (Ctrl-C to stop)"

while kill -0 "$WORKER_PID" 2>/dev/null; do
  NOW=$(date +%s)
  ELAPSED=$(( NOW - START ))

  # Worker RSS (KB → MB) + instantaneous CPU%.
  read -r RSS_KB CPU < <(ps -o rss=,%cpu= -p "$WORKER_PID" 2>/dev/null | awk '{print $1, $2}')
  RSS_KB="${RSS_KB:-0}"; CPU="${CPU:-0}"
  RSS_MB=$(( RSS_KB / 1024 ))

  # Host memory used (MB) + 1-min load average.
  SYS_USED=$(free -m 2>/dev/null | awk '/^Mem:/{print $3}'); SYS_USED="${SYS_USED:-0}"
  LOAD1=$(awk '{print $1}' /proc/loadavg 2>/dev/null); LOAD1="${LOAD1:-0}"

  echo "$(date '+%H:%M:%S'),${ELAPSED},${RSS_MB},${CPU},${SYS_USED},${LOAD1}" >> "$CSV"

  (( RSS_MB > PEAK_RSS )) && PEAK_RSS=$RSS_MB
  SUM_RSS=$(( SUM_RSS + RSS_MB ))
  awk "BEGIN{exit !($CPU > $PEAK_CPU)}" && PEAK_CPU=$CPU
  SUM_CPU=$(awk "BEGIN{print $SUM_CPU + $CPU}")
  SAMPLES=$(( SAMPLES + 1 ))

  printf "\r  %s  RSS=%4d MB  CPU=%5s%%  peak=%d MB  sysUsed=%s MB   " \
    "$(date '+%H:%M:%S')" "$RSS_MB" "$CPU" "$PEAK_RSS" "$SYS_USED"

  if (( DURATION > 0 && ELAPSED >= DURATION )); then break; fi
  sleep "$INTERVAL"
done

write_report
