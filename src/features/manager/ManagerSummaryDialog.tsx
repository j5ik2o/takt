import { Box, Text } from 'ink';
import type { ReactElement } from 'react';
import { getLabel } from '../../shared/i18n/index.js';

// The re-verification row appears only while a reserved registration awaits recovery.
export function ManagerSummaryDialog({ approve, lang, reverify }: {
  approve: boolean; lang: 'ja' | 'en'; reverify?: 'available' | 'selected';
}): ReactElement {
  return (
    <Box borderStyle="round" flexDirection="column">
      <Text bold>{getLabel('manager.summary.confirmation', lang)}</Text>
      <Text inverse={approve && reverify !== 'selected'}>{getLabel('manager.summary.approve', lang)}</Text>
      {reverify !== undefined && <Text inverse={reverify === 'selected'}>{getLabel('manager.summary.reverify', lang)}</Text>}
      <Text inverse={!approve && reverify !== 'selected'}>{getLabel('manager.summary.continue', lang)}</Text>
      <Text dimColor>{getLabel('manager.summary.dismissHint', lang)}</Text>
    </Box>
  );
}
