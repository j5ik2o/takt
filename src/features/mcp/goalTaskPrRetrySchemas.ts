import { z } from 'zod/v4';
import { goalWriteInputSchema, mergeGoalTaskInputSchema } from './schemas.js';

export const publishPrFailedGoalTaskInputSchema = goalWriteInputSchema.extend({
  taskName: mergeGoalTaskInputSchema.shape.taskName,
});

export type PublishPrFailedGoalTaskInput = z.infer<typeof publishPrFailedGoalTaskInputSchema>;
