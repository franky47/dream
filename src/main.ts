import { z } from 'zod'

const entrySchema = z.object({
  sessionId: z.uuidv4(),
  timestamp: z.iso.datetime(),
  project: z.string(),
  turns: z.number(),
  title: z.string(),
  description: z.string(),
  learnings: z.array(z.string()).default([]),
})
