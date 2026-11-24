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
  // The selection is the proposal revision it was made for, so it never carries over to another proposal.
  const [reverifySelected, setReverifySelected] = useState<number | null>(null);
  // Keys read the row from a ref so that an arrow followed by Enter in one input chunk sees the new row.
  const reverifyRow = useRef<number | null>(null);
  const selectReverify = (revision: number | null): void => { reverifyRow.current = revision; setReverifySelected(revision); };

  const dismiss = (target: PendingSummary): void => {
    selectReverify(null);
    void dismissSummary(target.revision);
    setPending(null);
    resetChoice();
  };
  const handleInput = (target: PendingSummary, key: Key,
    register: (revision: number, reverifyRegistration?: true) => Promise<void>): boolean => {
    if (key.upArrow || key.downArrow) {
      const rows = reverifyAvailable ? ['approve', 'reverify', 'continue'] as const : ['approve', 'continue'] as const;
      const current = reverifyAvailable && reverifyRow.current === target.revision ? 1 : selected.current ? 0 : rows.length - 1;
      const row = rows[Math.min(rows.length - 1, Math.max(0, current + (key.upArrow ? -1 : 1)))];
      selectReverify(row === 'reverify' ? target.revision : null);
      selected.current = row === 'approve';
      setApprove(selected.current);
      return true;
    }
    if (key.return) {
      if (reverifyAvailable && reverifyRow.current === target.revision) {
        selectReverify(null);
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

  const reverify = !reverifyAvailable ? undefined : pending !== null && reverifySelected === pending.revision ? 'selected' as const : 'available' as const;
  return { pending, setPending, dismiss, handleInput, reverify };
}
