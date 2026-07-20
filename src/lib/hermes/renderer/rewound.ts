import { z } from 'zod'

// Hermes withdraws turns from the live conversation with `/undo`. It keeps the
// rows in its state database but flips their activity flag off, so the audit
// record survives while the model no longer sees them.
//
// The raw JSONL keeps these rows untouched. Every Markdown path drops them, so
// withdrawn work never reads as part of the live conversation and never skews a
// fragment's time bounds, turn counts, or tool counts.
//
// Rewound rows and compaction-archived rows are both inactive. They stay
// distinct because compaction is recognised from the summary's content marker,
// not from this flag; that split is the compaction renderer's concern. Here we
// only read the activity flag, so this predicate never mistakes an ordinary
// live turn for a withdrawn one.
const activityFieldSchema = z.object({
  active: z.number().nullish(),
})

export function isRewound(row: unknown): boolean {
  const parsed = activityFieldSchema.safeParse(row)
  return parsed.success && parsed.data.active === 0
}
