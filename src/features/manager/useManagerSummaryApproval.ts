import { useRef, useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { PendingSummary } from '../../infra/conversations/schema.js';

export function useManagerSummaryApproval({ selected, setApprove, resetChoice, dismissSummary, reverifyAvailable }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
  dismissSummary: (revision: number) => Promise<void>;
  /** True while the proposal's registration is reserved and can be recovered by re-verification. */
  reverifyAvailable: boolean;
}) {
  const [pending, setPending] = useState<PendingSummary | null>(null);
  const [reverifySelected, setReverifySelected] = useState(false);
  // Keys read the row from a ref so that an arrow followed by Enter in one input chunk sees the new row.
  const reverifyRow = useRef(false);
  const selectReverify = (value: boolean): void => { reverifyRow.current = value; setReverifySelected(value); };

  const dismiss = (target: PendingSummary): void => {
    selectReverify(false);
    void dismissSummary(target.revision);
    setPending(null);
    resetChoice();
  };
  const handleInput = (target: PendingSummary, key: Key,
    register: (revision: number, reverifyRegistration?: true) => Promise<void>): boolean => {
    if (key.upArrow || key.downArrow) {
      const rows = reverifyAvailable ? ['approve', 'reverify', 'continue'] as const : ['approve', 'continue'] as const;
      const current = reverifyAvailable && reverifyRow.current ? 1 : selected.current ? 0 : rows.length - 1;
      const row = rows[Math.min(rows.length - 1, Math.max(0, current + (key.upArrow ? -1 : 1)))];
      selectReverify(row === 'reverify');
      selected.current = row === 'approve';
      setApprove(selected.current);
      return true;
    }
    if (key.return) {
      if (reverifyAvailable && reverifyRow.current) {
        selectReverify(false);
        void register(target.revision, true);
      } else if (selected.current) void register(target.revision);
      else dismiss(target);
      return true;
    }
    if (key.escape) { dismiss(target); return true; }
    // Typing resumes conversation and leaves the summary unavailable to UI approval.
    dismiss(target);
    return false;
  };

  const reverify = !reverifyAvailable ? undefined : reverifySelected ? 'selected' as const : 'available' as const;
  return { pending, setPending, dismiss, handleInput, reverify };
}
