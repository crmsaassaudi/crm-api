export type AgentStatus = 'available' | 'busy' | 'away' | 'offline';

/**
 * Agent presence - tracks the real-time state of a support agent.
 *
 * Stored in Redis for fast reads and TTL-based auto-expiry (heartbeat).
 */
export interface AgentPresence {
  /** Our internal user id */
  userId: string;

  tenantId: string;

  /** Current status */
  status: AgentStatus;

  /** How many active (open) conversations this agent is handling right now */
  activeConversations: number;

  /** Maximum concurrent conversations (per-agent or global default) */
  maxCapacity: number;

  /** Last heartbeat timestamp — if stale, agent is considered offline */
  lastHeartbeat: Date;

  /** Socket ID for targeted realtime events */
  socketId?: string;
}

/** Redis key helpers */
export const AGENT_PRESENCE_PREFIX = 'omni:agent:presence';
export const agentPresenceKey = (tenantId: string, userId: string) =>
  `${AGENT_PRESENCE_PREFIX}:${tenantId}:${userId}`;
export const tenantAgentsKey = (tenantId: string) =>
  `${AGENT_PRESENCE_PREFIX}:${tenantId}:*`;

/** Heartbeat TTL — if an agent doesn't heartbeat within this window, they go offline */
export const HEARTBEAT_TTL_SECONDS = 60;
