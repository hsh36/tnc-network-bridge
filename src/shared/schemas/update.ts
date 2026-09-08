import { type z } from 'zod';
import { updateStatusSchema, updateHistoryEntrySchema } from './operations';

export type UpdateStatus = z.infer<typeof updateStatusSchema>;
export type UpdateHistoryEntry = z.infer<typeof updateHistoryEntrySchema>;

export { updateStatusSchema, updateHistoryEntrySchema };
