import {
  DEFAULT_FORMAL_SPEC_MODEL_CHECK_TIMEOUT_SECONDS,
  type FormalSpecMode,
  type FormalSpecSetting,
} from '../../core/models/config-types.js';
import { loadGlobalConfig } from './global/globalConfig.js';
import { loadProjectConfig } from './project/projectConfig.js';
interface FormalSpecSettingLayers {
  projectSetting: FormalSpecSetting | undefined;
  globalSetting: FormalSpecSetting | undefined;
  lang: 'en' | 'ja';
}

export interface ResolvedFormalSpecConfiguration {
  mode: boolean;
  comments: boolean;
  modelCheckTimeoutSeconds: number;
}

function resolveFormalSpecSettingLayers(projectDir: string): FormalSpecSettingLayers {
  const projectConfig = loadProjectConfig(projectDir);
  const globalConfig = loadGlobalConfig();
  return {
    projectSetting: projectConfig.assistant?.formalSpec,
    globalSetting: globalConfig.assistant?.formalSpec,
    lang: (projectConfig.language ?? globalConfig.language) === 'ja' ? 'ja' : 'en',
  };
}

function getMode(setting: FormalSpecSetting | undefined): FormalSpecMode | undefined {
  if (setting === undefined) {
    return undefined;
  }
  return typeof setting === 'object' ? setting.mode : setting;
}

function getComments(setting: FormalSpecSetting | undefined): boolean | undefined {
  return typeof setting === 'object' ? setting.comments : undefined;
}

function getModelCheckTimeoutSeconds(setting: FormalSpecSetting | undefined): number | undefined {
  return typeof setting === 'object' ? setting.modelCheckTimeoutSeconds : undefined;
}

function configuredDefault(setting: Exclude<FormalSpecMode, boolean>): boolean {
  return setting === 'Y/n';
}

export function resolveFormalSpecSettingValues(projectDir: string): {
  mode: FormalSpecMode;
  comments: boolean;
  modelCheckTimeoutSeconds: number;
  lang: 'en' | 'ja';
} {
  const { projectSetting, globalSetting, lang } = resolveFormalSpecSettingLayers(projectDir);
  const mode = getMode(projectSetting) ?? getMode(globalSetting) ?? 'y/N';
  const comments = getComments(projectSetting) ?? getComments(globalSetting) ?? true;
  const modelCheckTimeoutSeconds = getModelCheckTimeoutSeconds(projectSetting)
    ?? getModelCheckTimeoutSeconds(globalSetting)
    ?? DEFAULT_FORMAL_SPEC_MODEL_CHECK_TIMEOUT_SECONDS;
  return { mode, comments, modelCheckTimeoutSeconds, lang };
}

function resolveModeWithoutPrompt(mode: FormalSpecMode): boolean {
  if (typeof mode === 'boolean') {
    return mode;
  }
  return configuredDefault(mode);
}

export function resolveFormalSpecConfigurationWithoutPrompt(
  projectDir: string,
): ResolvedFormalSpecConfiguration {
  const { mode, comments, modelCheckTimeoutSeconds } = resolveFormalSpecSettingValues(projectDir);
  return {
    mode: resolveModeWithoutPrompt(mode),
    comments,
    modelCheckTimeoutSeconds,
  };
}

