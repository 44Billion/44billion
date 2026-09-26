// Tuning knobs for the launcher-owned relay pool. The subscription and
// connection budgets stay below the 44b-relay per-connection/per-IP limits
// (30 subscriptions per socket, 30 connections per IP, 3 new connections per
// second, 10 per five seconds).
export const RELAY_POOL_LIMITS = Object.freeze({
  maxSubscriptionsPerBucket: 24,
  maxBucketsPerRelay: 4,
  maxNewConnectionsPerSecond: 3,
  maxNewConnectionsPerWindow: 10,
  connectionWindowMs: 5000,
  connectionBurstWindowMs: 1000,
  bucketIdleMs: 30000,
  messageBudgetPerBucket: 60,
  messageWindowMs: 2000,
  maxQueuedFramesPerMember: 256,
  maxQueuedBytesPerMember: 1024 * 1024,
  speculativeFrameLimit: 64,
  speculativeByteLimit: 256 * 1024,
  speculativeDecisionTimeoutMs: 10000,
  replayFrames: 32,
  replayBytes: 64 * 1024,
  dedupeEntries: 256,
  dedupeTtlMs: 5 * 60 * 1000,
  quarantineMs: 15 * 60 * 1000,
  consolidationThrottleMs: 5000,
  negSessionIdleMs: 60000,
  negTombstoneMs: 60000,
  closedSubscriptionTtlMs: 60000,
  authPendingTimeoutMs: 30000,
  nip11TimeoutMs: 3000,
  bridgeCreditFrames: 64,
  bridgeCreditBytes: 256 * 1024
})

// Internal postMessage codes for the dedicated app<->launcher relay channel.
export const RELAY_BRIDGE = Object.freeze({
  ATTACH: 'RELAY_ATTACH',
  ATTACHED: 'RELAY_ATTACHED',
  SEND: 'RELAY_SEND',
  FRAME: 'RELAY_FRAME',
  CREDIT: 'RELAY_CREDIT',
  CLOSE: 'RELAY_CLOSE',
  CLOSED: 'RELAY_CLOSED',
  DETACH: 'RELAY_DETACH',
  REGISTRY: 'RELAY_REGISTRY',
  FAILURE: 'RELAY_FAILURE',
  REGISTRY_ADD: 'RELAY_REGISTRY_ADD'
})
