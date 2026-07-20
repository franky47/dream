import { z } from 'zod'

// Hermes withdraws turns from the live conversation with `/undo`. It keeps the
// rows in its state database but flips their activity flag off, so the audit
// record survives while the model no longer sees them.
//
// The raw JSONL keeps these rows untouched. Every Markdown path drops them, so
// withdrawn work never reads as part of the live conversation and never skews a
// fragment's time bounds, turn counts, or tool counts.
//
// A rewound row and a compaction-archived row are both inactive (`active=0`),
// so the activity flag alone cannot tell them apart. Compaction sets
// `compacted=1` on the rows it archives; a `/undo` leaves `compacted=0`. Only
// the `active=0, compacted=0` pair is a genuine rewind. Compaction-archived
// rows (`active=0, compacted=1`) stay in the stream so they render in their
// earlier context window.
const activityFieldSchema = z.object({
  active: z.number().nullish(),
  compacted: z.number().nullish(),
})

export function isRewound(row: unknown): boolean {
  const parsed = activityFieldSchema.safeParse(row)
  return (
    parsed.success &&
    parsed.data.active === 0 &&
    (parsed.data.compacted ?? 0) === 0
  )
}
