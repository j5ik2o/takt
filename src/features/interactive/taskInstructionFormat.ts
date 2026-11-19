import { resolveFormalSpecConfigurationWithoutPrompt, resolveFormalSpecSettingValues, type ResolvedFormalSpecConfiguration } from '../../infra/config/formalSpecConfig.js';
export { resolveFormalSpecConfigurationWithoutPrompt, type ResolvedFormalSpecConfiguration } from '../../infra/config/formalSpecConfig.js';
import { getLabel } from '../../shared/i18n/index.js';
import { confirm, confirmWithCancel } from '../../shared/prompt/confirm.js';
import { resolveTtyPolicy } from '../../shared/prompt/tty.js';

export function resolveFormalSpecConfiguration(
  projectDir: string,
): Promise<ResolvedFormalSpecConfiguration>;
export function resolveFormalSpecConfiguration(
  projectDir: string,
  options: { allowCancel: true },
): Promise<ResolvedFormalSpecConfiguration | null>;
export async function resolveFormalSpecConfiguration(
  projectDir: string,
  options?: { allowCancel: true },
): Promise<ResolvedFormalSpecConfiguration | null> {
  const { mode, comments, modelCheckTimeoutSeconds, lang } = resolveFormalSpecSettingValues(projectDir);
  if (typeof mode === 'boolean') {
    return { mode, comments, modelCheckTimeoutSeconds };
  }

  const defaultYes = mode === 'Y/n';
  if (!resolveTtyPolicy().useTty) {
    return { mode: defaultYes, comments, modelCheckTimeoutSeconds };
  }

  const message = getLabel('interactive.formalSpecPrompt', lang);
  let confirmedMode: boolean;
  if (options?.allowCancel) {
    const confirmed = await confirmWithCancel(message, defaultYes);
    if (confirmed.kind === 'cancelled') {
      return null;
    }
    confirmedMode = confirmed.value;
  } else {
    confirmedMode = await confirm(message, defaultYes);
  }
  return {
    mode: confirmedMode,
    comments,
    modelCheckTimeoutSeconds,
  };
}

export function resolveFormalSpecModeWithoutPrompt(projectDir: string): boolean {
  return resolveFormalSpecConfigurationWithoutPrompt(projectDir).mode;
}

export async function resolveFormalSpecMode(projectDir: string): Promise<boolean> {
  const configuration = await resolveFormalSpecConfiguration(projectDir);
  return configuration.mode;
}

export function resolveFormalSpecCommentsWithoutPrompt(projectDir: string): boolean {
  return resolveFormalSpecConfigurationWithoutPrompt(projectDir).comments;
}
