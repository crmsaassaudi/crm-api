#!/usr/bin/env bash
#
# Monitor a CRM container (worker) during a contact-import load test, via
# `docker stats` — no PID hunting needed. Use this instead of
# monitor-worker-memory.sh when the worker runs inside Docker.
#
# Usage:
#   ./monitor-docker.sh crm-api                 # monitor container "crm-api"
#   CONTAINER=crm-worker ./monitor-docker.sh
#   INTERVAL=2 DURATION=300 KPI_MB=500 OUT_DIR=./loadtest-report ./monitor-docker.sh crm-api
#
# IMPORTANT: monitor the container that actually runs the import worker
# (APP_RUNTIME=worker). Check with:  docker top <container>
#
# Produces in OUT_DIR:
#   samples.csv   timestamp,elapsed_s,mem_mb,mem_limit_mb,cpu_pct
#   report.md     summary (peak/avg mem, peak CPU, KPI PASS/FAIL)
#
set -uo pipefail

CONTAINER="${1:-${CONTAINER:-crm-api}}"
INTERVAL="${INTERVAL:-2}"
DURATION="${DURATION:-0}"          # 0 = until Ctrl-C or container stops
KPI_MB="${KPI_MB:-500}"
OUT_DIR="${OUT_DIR:-./loadtest-report}"

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found on PATH." >&2; exit 1
fi
if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "ERROR: container '$CONTAINER' not found. Run 'docker ps' to list." >&2
  exit 1
fi

mkdir -p "$OUT_DIR"
CSV="$OUT_DIR/samples.csv"
REPORT="$OUT_DIR/report.md"
echo "timestamp,elapsed_s,mem_mb,mem_limit_mb,cpu_pct" > "$CSV"

# Convert a docker size token (e.g. 123.4MiB / 1.2GiB / 512kB) → MB (float).
to_mb() {
  awk -v s="$1" 'BEGIN{
    u=s; sub(/[0-9.]+/,"",u); v=s; sub(/[A-Za-z]+/,"",v);
    f=1;
    if (u=="GiB") f=1073741824; else if (u=="MiB") f=1048576;
    else if (u=="KiB") f=1024; else if (u=="GB") f=1000000000;
    else if (u=="MB") f=1000000; else if (u=="kB"||u=="KB") f=1000;
    else if (u=="B") f=1;
    printf "%.1f", (v*f)/1048576;
  }'
}

START=$(date +%s)
PEAK_MEM=0; SUM_MEM=0; PEAK_CPU=0; SUM_CPU=0; SAMPLES=0; LIMIT_MB=0

write_report() {
  local END elapsed avg_mem avg_cpu kpi
  END=$(date +%s); elapsed=$(( END - START ))
  if (( SAMPLES > 0 )); then
    avg_mem=$(awk "BEGIN{printf \"%.0f\", $SUM_MEM/$SAMPLES}")
    avg_cpu=$(awk "BEGIN{printf \"%.1f\", $SUM_CPU/$SAMPLES}")
  else avg_mem=0; avg_cpu=0; fi
  awk "BEGIN{exit !($PEAK_MEM <= $KPI_MB)}" && kpi="PASS ✅" || kpi="FAIL ❌"

  {
    echo "# Contact Import — Docker Monitor Report"
    echo
    echo "- Generated : $(date '+%Y-%m-%d %H:%M:%S')"
    echo "- Container : $CONTAINER"
    echo "- Mem limit : ${LIMIT_MB} MB"
    echo "- Duration  : ${elapsed}s over ${SAMPLES} samples (every ${INTERVAL}s)"
    echo
    echo "## Container memory"
    echo
    echo "| Metric | Value | KPI |"
    echo "| ------ | ----- | --- |"
    echo "| Peak mem | ${PEAK_MEM} MB | ≤ ${KPI_MB} MB → ${kpi} |"
    echo "| Avg mem  | ${avg_mem} MB | — |"
    echo "| Peak CPU | ${PEAK_CPU}% | — |"
    echo "| Avg CPU  | ${avg_cpu}% | — |"
    echo
    echo "## Notes"
    echo
    echo "- \`docker stats\` reports the WHOLE container's RSS (node + anything"
    echo "  else in it). If the container runs only the worker, this ≈ heap."
    echo "- Flat curve regardless of file size = streaming OK; linear growth ="
    echo "  suspected leak."
    echo "- Raw samples: \`samples.csv\`."
  } > "$REPORT"

  echo
  echo "──────────────── Summary ────────────────"
  echo "  container : $CONTAINER   (limit ${LIMIT_MB} MB)"
  echo "  samples   : $SAMPLES     duration: ${elapsed}s"
  echo "  peak mem  : ${PEAK_MEM} MB   (KPI ≤ ${KPI_MB} MB → ${kpi})"
  echo "  avg  mem  : ${avg_mem} MB"
  echo "  peak CPU  : ${PEAK_CPU}%   avg CPU: ${avg_cpu}%"
  echo "  report    : $REPORT"
}

trap 'write_report; exit 0' INT TERM

echo "Monitoring container '$CONTAINER' every ${INTERVAL}s → $OUT_DIR (Ctrl-C to stop)"

while docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; do
  NOW=$(date +%s); ELAPSED=$(( NOW - START ))

  # "123.4MiB / 2GiB" and "5.20%"
  LINE=$(docker stats --no-stream --format '{{.MemUsage}}|{{.CPUPerc}}' "$CONTAINER" 2>/dev/null)
  MEM_USAGE=$(echo "$LINE" | awk -F'|' '{print $1}')
  CPU=$(echo "$LINE" | awk -F'|' '{print $2}' | tr -d '%')
  USED_TOK=$(echo "$MEM_USAGE" | awk '{print $1}')
  LIMIT_TOK=$(echo "$MEM_USAGE" | awk '{print $3}')
  MEM_MB=$(to_mb "$USED_TOK"); [[ -z "$MEM_MB" ]] && MEM_MB=0
  LIMIT_MB=$(to_mb "$LIMIT_TOK"); LIMIT_MB=${LIMIT_MB%.*}
  CPU="${CPU:-0}"

  MEM_INT=${MEM_MB%.*}
  echo "$(date '+%H:%M:%S'),${ELAPSED},${MEM_MB},${LIMIT_MB},${CPU}" >> "$CSV"

  (( MEM_INT > PEAK_MEM )) && PEAK_MEM=$MEM_INT
  SUM_MEM=$(awk "BEGIN{print $SUM_MEM + $MEM_MB}")
  awk "BEGIN{exit !($CPU > $PEAK_CPU)}" && PEAK_CPU=$CPU
  SUM_CPU=$(awk "BEGIN{print $SUM_CPU + $CPU}")
  SAMPLES=$(( SAMPLES + 1 ))

  printf "\r  %s  mem=%6s MB  cpu=%6s%%  peak=%d MB / limit %s MB   " \
    "$(date '+%H:%M:%S')" "$MEM_MB" "$CPU" "$PEAK_MEM" "$LIMIT_MB"

  if (( DURATION > 0 && ELAPSED >= DURATION )); then break; fi
  sleep "$INTERVAL"
done

write_report
