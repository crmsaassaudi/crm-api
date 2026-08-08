#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
#  Prove the local Redis topology matches the production reference.
#
#  Three checks, in increasing order of how much they actually catch:
#
#    1. Eviction policy per instance. A queue on an evicting instance loses
#       jobs with no error on either side — the producer saw a successful
#       add(), no worker ever sees it, nothing is logged.
#    2. Known key families landed on the instance that owns them. Config
#       claiming "cache is on 6381" means nothing until a `session:` key is
#       observed on 6379 and nowhere else.
#    3. A census of every prefix actually present. Check 2 only knows the
#       families listed below; this one surfaces the ones nobody thought of.
#
#  Run after `docker compose -f docker-compose.redis.yml up -d`. Checks 2 and 3
#  only say anything once the API has served a login and queued a job.
#
#      bash scripts/verify-redis-topology.sh
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

HOST="${REDIS_HOST:-127.0.0.1}"
CORE_PORT="${CORE_PORT:-6379}"
QUEUE_PORT="${QUEUE_PORT:-6380}"
CACHE_PORT="${CACHE_PORT:-6381}"

AUTH=()
[ -n "${REDIS_PASSWORD:-}" ] && AUTH=(-a "$REDIS_PASSWORD" --no-auth-warning)

# Prefer a redis-cli on the host. Without one, borrow the one inside the core
# container and address the other two by their compose service names — they
# share a network, so this needs no host.docker.internal and works the same on
# Linux, macOS and Docker Desktop.
if command -v redis-cli >/dev/null 2>&1; then
  rcli() { redis-cli -h "$HOST" -p "$1" "${AUTH[@]}" "${@:2}" 2>/dev/null; }
elif docker exec crm-redis-core true >/dev/null 2>&1; then
  svc_for_port() {
    case "$1" in
      "$CORE_PORT")  echo redis ;;
      "$QUEUE_PORT") echo redis-queue ;;
      "$CACHE_PORT") echo redis-cache ;;
    esac
  }
  rcli() {
    docker exec crm-redis-core redis-cli -h "$(svc_for_port "$1")" -p 6379 \
      "${AUTH[@]}" "${@:2}" 2>/dev/null
  }
else
  echo "Need either a host redis-cli or a running crm-redis-core container."
  echo "  cd ../crm-redis && docker compose up -d"
  exit 2
fi

fail=0

# SCAN, never KEYS. KEYS blocks the single thread this whole exercise is about,
# and a verification script has no business demonstrating the bug it checks for.
scan_count() {
  local port="$1" pattern="$2" cursor=0 total=0 out
  while :; do
    out=$(rcli "$port" SCAN "$cursor" MATCH "$pattern" COUNT 1000)
    [ -z "$out" ] && { echo 0; return; }
    cursor=$(printf '%s\n' "$out" | head -1)
    total=$(( total + $(printf '%s\n' "$out" | tail -n +2 | grep -c .) ))
    [ "$cursor" = "0" ] && break
  done
  echo "$total"
}

# ── 1. eviction policy ───────────────────────────────────────────────────────
echo
echo "eviction policy"
check_policy() {
  local label="$1" port="$2" want="$3" got
  got=$(rcli "$port" CONFIG GET maxmemory-policy | tail -1)
  if [ -z "$got" ]; then
    printf '  \033[31m✗\033[0m %-6s :%-5s unreachable\n' "$label" "$port"; fail=1
  elif [ "$got" = "$want" ]; then
    printf '  \033[32m✓\033[0m %-6s :%-5s %s\n' "$label" "$port" "$got"
  else
    printf '  \033[31m✗\033[0m %-6s :%-5s %s  (expected %s)\n' "$label" "$port" "$got" "$want"; fail=1
  fi
}
check_policy core  "$CORE_PORT"  noeviction
check_policy queue "$QUEUE_PORT" noeviction
check_policy cache "$CACHE_PORT" allkeys-lru

# ── 2. known key families ────────────────────────────────────────────────────
#
# Every prefix below was read out of the source, not guessed. Note that which
# instance owns a key is decided by the client the service reached for, not by
# the key's name — RedisService exposes BOTH cache-manager (→ cache) and a raw
# ioredis client via getClient() (→ core):
#
#   session:*          src/auth/services/session.service.ts            → core
#   omni:*             presence / agent load, operational state        → core
#   automation:idem:*  engine/action-idempotency.service.ts            → core
#   authz:*            common/permissions/*, data-visibility/*         → core
#                      via RedisService.getClient(). Correct, and not merely
#                      conservative: `authz:policy:*:version` and
#                      `authz:scope:*:version` are INCR counters that versioned
#                      entries are keyed on. Evicting a counter restarts it at
#                      1, and previously cached v1 entries then read as current
#                      — stale permissions, served silently. Counters belong on
#                      noeviction; that is exactly what core is for.
#   bull:*             BullMQ default; queue.module.ts sets no prefix   → queue
#   tenant:member:* user:keycloak:* user:i18n:*
#                      common/interceptors/tenant.interceptor.ts via
#                      RedisService.get/set, i.e. cache-manager         → cache
echo
echo "key placement                       core    queue   cache"
for row in \
  "session:*|session|core" \
  "automation:idem:*|automation idempotency|core" \
  "authz:*|authz + policy versions|core" \
  "bull:*|bullmq|queue" \
  "tenant:member:*|tenant member cache|cache" \
  "user:keycloak:*|keycloak id cache|cache"
do
  IFS='|' read -r pattern label owner <<< "$row"
  c=$(scan_count "$CORE_PORT" "$pattern")
  q=$(scan_count "$QUEUE_PORT" "$pattern")
  k=$(scan_count "$CACHE_PORT" "$pattern")

  case "$owner" in
    core)  stray=$(( q + k )) ;;
    queue) stray=$(( c + k )) ;;
    cache) stray=$(( c + q )) ;;
  esac

  if [ "$stray" -gt 0 ]; then
    printf '  \033[31m✗\033[0m %-31s %-7s %-7s %-7s → %s only\n' "$label" "$c" "$q" "$k" "$owner"; fail=1
  elif [ $(( c + q + k )) -eq 0 ]; then
    printf '  \033[90m·\033[0m %-31s %-7s %-7s %-7s (none yet)\n' "$label" "$c" "$q" "$k"
  else
    printf '  \033[32m✓\033[0m %-31s %-7s %-7s %-7s\n' "$label" "$c" "$q" "$k"
  fi
done

# ── 3. prefix census ─────────────────────────────────────────────────────────
#
# Advisory, never fails the run: it reports what is there rather than judging
# it. The check above can only see families it was told about, and the ones
# worth finding are the ones nobody listed.
echo
echo "prefix census (advisory — everything actually present)"
census() {
  local label="$1" port="$2" cursor=0 out all total
  # Walk the whole keyspace once, then derive both the total and the prefix
  # breakdown from it — scanning twice can disagree with itself on a live
  # instance and make a clean topology look broken.
  all=$(
    while :; do
      out=$(rcli "$port" SCAN "$cursor" COUNT 1000)
      [ -z "$out" ] && break
      cursor=$(printf '%s\n' "$out" | head -1)
      printf '%s\n' "$out" | tail -n +2
      [ "$cursor" = "0" ] && break
    done
  )
  total=$(printf '%s\n' "$all" | grep -c .)
  printf '  %-6s :%-5s %s keys\n' "$label" "$port" "$total"
  [ "$total" -eq 0 ] && return
  printf '%s\n' "$all" | grep . | cut -d: -f1 | sort | uniq -c | sort -rn | head -8 |
    awk '{ printf "        %-28s %s\n", $2, $1 }'
}
census core  "$CORE_PORT"
census queue "$QUEUE_PORT"
census cache "$CACHE_PORT"

echo
if [ "$fail" -eq 0 ]; then
  echo -e "\033[32mtopology matches the production reference\033[0m"
else
  echo -e "\033[31mtopology diverges — see rows above\033[0m"
fi
echo
exit "$fail"
