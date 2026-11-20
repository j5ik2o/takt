import { z } from 'zod/v4';
import { GoalWorkLogInputSchema } from '../../infra/goals/schema.js';
import { goalWriteInputSchema } from './schemas.js';

export const finishGoalInputSchema = goalWriteInputSchema.extend({
  reason: GoalWorkLogInputSchema.shape.summary.describe('Required reason for finishing the aborted goal. Saved in the work log without trimming. When the goal has no completion record, the reason also becomes the completion summary; an existing completion summary is preserved.'),
});

export type FinishGoalInput = z.infer<typeof finishGoalInputSchema>;
