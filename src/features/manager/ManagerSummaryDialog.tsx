import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';

export function ManagerSummaryDialog({ approve, lang, reverifyAvailable = false, reverifySelected = false }: {
  approve: boolean; lang: 'ja' | 'en'; reverifyAvailable?: boolean; reverifySelected?: boolean;
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.summary.confirmation', lang)}</Text>
      <Text inverse={!reverifySelected && approve}>{getLabel('manager.summary.approve', lang)}</Text>
      {reverifyAvailable && <Text inverse={reverifySelected}>{getLabel('manager.summary.reverify', lang)}</Text>}
      <Text inverse={!reverifySelected && !approve}>{getLabel('manager.summary.continue', lang)}</Text>
      <Text dimColor>{getLabel('manager.summary.dismissHint', lang)}</Text>
    </Box>
  );
}
