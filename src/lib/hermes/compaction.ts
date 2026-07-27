// The single marker Hermes writes at the head of every compaction summary.
// Two consumers key on it: the SQL projection detects a rotated continuation by
// prefix-matching a session's first user turn against it, and the renderer
// splits a stream into context windows on it. Sharing one literal keeps the
// detection and the splitting from drifting apart.
export const COMPACTION_SUMMARY_PREFIX = '[CONTEXT COMPACTION — REFERENCE ONLY]'
