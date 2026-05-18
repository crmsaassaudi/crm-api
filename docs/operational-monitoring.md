# Operational Monitoring Checkpoints

This runbook covers the Redis, BullMQ, and MongoDB signals required by the
reliability hardening work.

## Redis

- Alert when p95 command latency or `PING` latency is above 50 ms for 5 minutes.
- Alert on connection error/reconnect spikes from API and worker pods.
- Track authz permission cache hit/miss from `AuthzPermissionCacheService` logs.

## BullMQ

- Alert when any queue has failed jobs increasing for 5 minutes.
- Alert when `automation-actions-dlq` depth is greater than 0.
- Dashboard queue depth, active jobs, delayed jobs, failed jobs, and waiting time
  for `omni-webhooks`, `omni-routing`, and automation queues.

## MongoDB

- Watch slow queries on `omni_messages`, `users`, `groups`, and
  `automation_execution_logs`.
- Verify operational indexes before staging/prod rollout:

```bash
npm run ops:verify-indexes
```

The script fails the deploy if required deduplication, lookup, or TTL indexes
are missing.
