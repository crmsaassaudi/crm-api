# Epic: Two-Way Read State Sync (Opt-in)

## 1. Problem Statement & Motivation
Currently, the IMAP Inbound Poller only fetches emails but does **not** mutate the `\Seen` flag on the provider side (Gmail/Outlook). This respects the user's native email workflow, as many users rely on the "Unread" status as a rudimentary To-Do list. The CRM operates strictly as a business record system and does not arbitrarily "steal" the notification state.

However, some organizations may *want* their actions in the CRM to reflect back to their Gmail/Outlook. If an agent reads an email on the CRM UI, they want it marked as Read on Gmail.

**Goal:** Implement an **Opt-in** Two-Way Read State Sync feature that decouples the read-state mutation from the ingestion (polling) phase.

## 2. Architectural Principles
- **Decoupled:** The `ImapPollerService` remains strictly Read-Only.
- **Event-Driven:** Syncing the read state is triggered strictly by user actions on the UI, not by background cron jobs.
- **Opt-In:** The feature is disabled by default to protect existing user workflows.

## 3. Implementation Steps

### Phase 1: Configuration & UI (Tenant Level)
1. **Database Schema Update:**
   - Modify `ChannelConfig` schema to include `syncReadState: boolean` (default: `false`).
2. **Channel Settings UI:**
   - Add a toggle in the Email Channel Settings: *"Sync 'Read' status back to email provider"*.
   - Include a warning tooltip: *"If enabled, reading an email in the CRM will mark it as read in your native Gmail/Outlook inbox."*
3. **Backend API:**
   - Ensure the settings update API accepts and saves the `syncReadState` flag.

### Phase 2: Event-Driven Sync Mechanism (Background Worker)
1. **User Action Trigger:**
   - When an agent opens an email conversation in the Omni-channel UI, the frontend calls an endpoint to mark the local `omni_messages` as `isRead = true`.
2. **Event Emission:**
   - Upon successful local DB update (Read or Unread action), emit a domain event: `email.read_state.changed`.
   - **Payload:** `{ tenantId, configId, messageUid, targetState: 'read' | 'unread' }`.
3. **Queue / Worker (BullMQ + imapflow):**
   - Create a new BullMQ worker: `ReadStateSyncWorker`.
   - The worker listens for `email.read_state.changed`.
   - **Logic (Connection Pooling & Batching):**
     1. Check if `ChannelConfig.syncReadState === true`. If false, drop the job.
     2. **Batching:** Group multiple read/unread events for the same `configId` into a single batch to avoid creating short-lived connections for every single click.
     3. **Redis Lock:** Acquire a Redis lock for the specific `Message-ID` to prevent concurrent workers from processing the exact same message.
     4. Retrieve IMAP credentials and acquire a connection from a **Short-Lived Connection Pool**.
     5. Connect to the IMAP provider using `imapflow`.
     6. Execute `client.messageFlagsAdd([uid], ['\\Seen'])` for `targetState: 'read'`, or `client.messageFlagsRemove([uid], ['\\Seen'])` for `targetState: 'unread'`.
     7. Release connection back to the pool.

### Phase 3: Fail-safes & Edge Cases
- **Idempotency & Race Conditions:** Add a `syncStatus` field (e.g., `pending`, `synced`, `failed`) and a `lastSyncError` (text) field to `omni_messages` or a separate sync log table. This prevents infinite retries, prevents sending identical IMAP commands when an agent clicks back and forth, and helps Support debug without digging through BullMQ logs.
- **UID Validity Fallback:** IMAP UIDs can change if `UIDValidity` changes. The worker should search by `Message-ID` header (`client.search({ header: { 'message-id': messageId } })`) to ensure absolute accuracy when targeting the email to mark as read.
- **Provider Rate Limiting (Throttling) & BullMQ Batching:** IMAP servers (like Outlook) strictly rate-limit commands. Implement throttling per `configId`. To batch efficiently, use BullMQ Delayed Jobs (5-10s) to aggregate rapid clicks, or have the worker use `getJobs` to clear all pending syncs for a `configId` in one IMAP connection.
- **Error Handling (Auth vs Transient):** 
  - *Transient errors (timeout):* Retry a maximum of 3 times with exponential backoff. 
  - *Authentication errors (invalid credentials/expired token):* **DO NOT RETRY**. Immediately halt processing, mark `ChannelConfig` as `invalid`, and dispatch an alert to the user.

## 4. Definition of Done (DoD)
- [ ] `syncReadState` toggle exists in the UI and persists in `ChannelConfig`.
- [ ] `ImapPollerService` does not mark emails as read (already implemented).
- [ ] Opening an email in CRM triggers a background job.
- [ ] If `syncReadState=true`, the background job successfully sets the `\Seen` flag on Gmail/Outlook.
- [ ] UI remains responsive regardless of the IMAP sync background job's success or failure.
