/**
 * Reservation scripts for the ZSET-backed load store.
 *
 * All three keep the SAME invariant: a returned candidate has already had its
 * load counter incremented inside the script, so two concurrent decisions can
 * never hand the same slot to two records. `RELEASE` is the exact inverse.
 *
 * This is the property the old record engine lacked. Its round-robin advanced a
 * cursor without touching load at all, and its `least-busy` seeded scores with
 * `ZADD NX` under a 300s TTL — so after five idle seconds every increment was
 * lost and the pool reverted to a stale MongoDB count.
 *
 * Score semantics: `ZSCORE key member` is the candidate's current open-work
 * count. A member missing from the ZSET has not been seeded and is skipped —
 * callers seed before reserving.
 *
 * KEYS[1] = load ZSET
 * KEYS[2] = per-candidate capacity HASH (member → max), may be empty
 * ARGV[1] = candidate count N
 * ARGV[2..N+1] = candidate ids, in caller-preferred order
 * ARGV[N+2] = default capacity ceiling
 */

/**
 * First-fit over the caller's order: take the FIRST candidate still under
 * capacity. Preserves round-robin rotation, which a load-ordered pick would
 * silently collapse into least-busy.
 */
export const LUA_RESERVE_FIRST_ELIGIBLE = `
local loadKey = KEYS[1]
local capKey = KEYS[2]
local n = tonumber(ARGV[1])
local defaultCap = tonumber(ARGV[n + 2])

for i = 1, n do
  local id = ARGV[i + 1]
  local score = redis.call('ZSCORE', loadKey, id)
  if score then
    local cap = defaultCap
    if capKey ~= '' then
      local perAgent = redis.call('HGET', capKey, id)
      if perAgent then cap = tonumber(perAgent) end
    end
    if cap == nil or cap <= 0 then cap = defaultCap end
    if tonumber(score) < cap then
      redis.call('ZINCRBY', loadKey, 1, id)
      return id
    end
  end
end
return nil
`;

/**
 * Lowest load wins, ties broken by the caller's order. Capacity is NOT checked:
 * `least-busy` means "whoever has the least", which is the documented behaviour
 * and the reason `capacity-based` exists as a separate strategy.
 */
export const LUA_RESERVE_LEAST_BUSY = `
local loadKey = KEYS[1]
local n = tonumber(ARGV[1])
local bestId = nil
local bestLoad = nil

for i = 1, n do
  local id = ARGV[i + 1]
  local score = redis.call('ZSCORE', loadKey, id)
  if score then
    local load = tonumber(score)
    if bestLoad == nil or load < bestLoad then
      bestLoad = load
      bestId = id
    end
  end
end

if not bestId then return nil end
redis.call('ZINCRBY', loadKey, 1, bestId)
return bestId
`;

/** Lowest load among candidates still strictly under their effective capacity. */
export const LUA_RESERVE_CAPACITY_BASED = `
local loadKey = KEYS[1]
local capKey = KEYS[2]
local n = tonumber(ARGV[1])
local defaultCap = tonumber(ARGV[n + 2])
local bestId = nil
local bestLoad = nil

for i = 1, n do
  local id = ARGV[i + 1]
  local score = redis.call('ZSCORE', loadKey, id)
  if score then
    local load = tonumber(score)
    local cap = defaultCap
    if capKey ~= '' then
      local perAgent = redis.call('HGET', capKey, id)
      if perAgent then cap = tonumber(perAgent) end
    end
    if cap == nil or cap <= 0 then cap = defaultCap end
    if load < cap and (bestLoad == nil or load < bestLoad) then
      bestLoad = load
      bestId = id
    end
  end
end

if not bestId then return nil end
redis.call('ZINCRBY', loadKey, 1, bestId)
return bestId
`;

/**
 * Read-only counterpart to the three reserve scripts: returns who WOULD be
 * picked, incrementing nothing.
 *
 * ARGV[n+3] carries the strategy so one script covers all three, which keeps the
 * preview and the reservation from drifting apart — the dry run must not have its
 * own idea of who wins.
 */
export const LUA_PREVIEW = `
local loadKey = KEYS[1]
local capKey = KEYS[2]
local n = tonumber(ARGV[1])
local defaultCap = tonumber(ARGV[n + 2])
local strategy = ARGV[n + 3]
local ignoreCap = (strategy == 'least-busy')
local firstFit = (strategy == 'round-robin')
local bestId = nil
local bestLoad = nil

for i = 1, n do
  local id = ARGV[i + 1]
  local score = redis.call('ZSCORE', loadKey, id)
  if score then
    local load = tonumber(score)
    local cap = defaultCap
    if capKey ~= '' then
      local perAgent = redis.call('HGET', capKey, id)
      if perAgent then cap = tonumber(perAgent) end
    end
    if cap == nil or cap <= 0 then cap = defaultCap end
    if ignoreCap or load < cap then
      if firstFit then return id end
      if bestLoad == nil or load < bestLoad then
        bestLoad = load
        bestId = id
      end
    end
  end
end
return bestId
`;

/**
 * Undo one reservation, clamped at zero.
 *
 * The clamp matters: without it a double release (a retry that both rolls back
 * and gets rolled back by its caller) drives the score negative and that
 * candidate then wins every least-busy pick forever.
 *
 * KEYS[1] = load ZSET · ARGV[1] = candidate id
 */
export const LUA_RELEASE = `
local loadKey = KEYS[1]
local id = ARGV[1]
local score = redis.call('ZSCORE', loadKey, id)
if not score then return 0 end
local next = tonumber(score) - 1
if next < 0 then next = 0 end
redis.call('ZADD', loadKey, next, id)
return 1
`;
