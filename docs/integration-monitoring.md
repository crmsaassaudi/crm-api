# Integration Monitoring & Resilience Dashboard

This document describes the API endpoints available for monitoring external integration health (HubSpot, Facebook, etc.) and testing the resilience mechanisms.

## 1. Test Endpoints (Trigger Traffic)

Use these endpoints to simulate successful and failed requests to external services. This will populate the metrics.

### Simulate Success (Facebook Service)
Calls a reliable external URL via the `facebook` resilience policy.

- **URL**: `GET /test-http/facebook`
- **Query Params**:
  - `url`: (Optional) The target URL to proxy. Defaults to a 200 OK service.
- **Example**:
  ```bash
  curl -v "http://localhost:3000/test-http/facebook?url=http://httpstat.us/200"
  ```

### Simulate Failure (Generic Service)
Calls a failing external URL via the `generic` resilience policy (retries enabled).

- **URL**: `GET /test-http/fail`
- **Query Params**:
  - `url`: (Optional) The target URL. Defaults to a 500 Error service.
- **Example**:
  ```bash
  curl -v "http://localhost:3000/test-http/fail?url=http://httpstat.us/500"
  ```
  *Note: You will see multiple attempts in the server logs due to retry policy.*

---

## 2. Dashboard Endpoints (Monitor Health)

These endpoints provide real-time visibility into the health of your integrations.

### Get Aggregated Metrics
Returns statistics (success rate, error rate, average duration) for each service.

- **URL**: `GET /admin/integrations/metrics`
- **Response**:
  ```json
  {
    "facebook": {
      "total": 15,
      "success": 12,
      "error": 3,
      "errorRate": 20.0,
      "avgTime": 450
    },
    "generic": {
      "total": 5,
      "success": 0,
      "error": 5,
      "errorRate": 100.0,
      "avgTime": 1200
    }
  }
  ```
- **Example**:
  ```bash
  curl -v "http://localhost:3000/admin/integrations/metrics"
  ```

### Get Request Logs
Returns a chronological list of recent integration requests (success & failure).

- **URL**: `GET /admin/integrations/logs`
- **Query Params**:
  - `limit`: (Optional) Number of logs to return. Default: 100.
- **Response**:
  ```json
  [
    {
      "service": "facebook",
      "url": "http://httpstat.us/200",
      "method": "GET",
      "status": 200,
      "success": true,
      "durationMs": 150,
      "retries": 0,
      "createdAt": "2023-10-27T10:05:00.000Z"
    },
    {
      "service": "generic",
      "status": 500,
      "success": false,
      "retries": 3,
      "createdAt": "2023-10-27T10:04:55.000Z"
    }
  ]
  ```
- **Example**:
  ```bash
  curl -v "http://localhost:3000/admin/integrations/logs?limit=50"
  ```

---

## 3. How it Works

1.  **Interceptor/Service**: Every request made via `ResilienceHttpService` is automatically tracked.
2.  **Policies**: The resilience layer (`cockatiel`) handles retries and circuit breaking.
3.  **Storage**: Logs are asynchronously written to MongoDB in the `integrationlogs` collection.
4.  **Aggregation**: The `/metrics` endpoint uses MongoDB aggregation to calculate real-time stats.
