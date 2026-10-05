import { z } from "zod";

const TicketFields = z.object({
  id: z.string().min(1),
  title: z.string(),
  body: z.string(),
  createdAt: z.iso.datetime({ offset: true }),
  reporter: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      department: z.string().optional(),
    })
    .optional(),
  reporterPriority: z.string().optional(),
  comments: z
    .array(
      z.object({
        author: z.string(),
        body: z.string(),
        createdAt: z.iso.datetime({ offset: true }),
      }),
    )
    .optional(),
  attachments: z
    .array(z.object({ filename: z.string(), mimeType: z.string().optional() }))
    .optional(),
});

export type Ticket = z.output<typeof TicketFields> & { raw?: Record<string, unknown> };

// SPEC §3.1. Unknown top-level fields are preserved in `raw` and never sent to the LLM.
export const TicketSchema = z
  .looseObject(TicketFields.shape)
  .transform((input): Ticket => {
    const ticket: Record<string, unknown> = {};
    const raw: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      (key in TicketFields.shape ? ticket : raw)[key] = value;
    }
    if (Object.keys(raw).length > 0) ticket.raw = raw;
    return ticket as Ticket;
  });
