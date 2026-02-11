import type { PieceMovement } from '../models/types.js';

export type ProviderType = 'claude' | 'codex' | 'opencode' | 'mock';

export interface MovementProviderModelInput {
  step: Pick<PieceMovement, 'provider' | 'model' | 'personaDisplayName'>;
  provider?: ProviderType;
  model?: string;
  personaProviders?: Record<string, ProviderType>;
}

export interface MovementProviderModelOutput {
  provider?: ProviderType;
  model?: string;
}

export function resolveMovementProviderModel(input: MovementProviderModelInput): MovementProviderModelOutput {
  return {
    provider: input.step.provider
      ?? input.personaProviders?.[input.step.personaDisplayName]
      ?? input.provider,
    model: input.step.model ?? input.model,
  };
}
