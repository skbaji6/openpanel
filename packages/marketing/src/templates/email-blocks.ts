import { z } from 'zod';

const MAX_SUBJECT_LENGTH = 300;

// Placeholder until the email block editor lands; it replaces this schema.
export const zEmailContent = z.strictObject({
  subject: z.string().max(MAX_SUBJECT_LENGTH),
  blocks: z.array(z.unknown()).min(1),
});
