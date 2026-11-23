import { useRef, useState, type RefObject } from 'react';
import type { Key } from 'ink';
import type { PendingSummary } from '../../infra/conversations/schema.js';

export function useManagerSummaryApproval({ selected, setApprove, resetChoice, dismissSummary, reverify, reverifyAvailable }: {
  selected: RefObject<boolean>;
  setApprove: (approve: boolean) => void;
  resetChoice: () => void;
  dismissSummary: (revision: number) => Promise<void>;
  reverify: (revision: number) => Promise<void>;
  reverifyAvailable: boolean;
}) {
  const [pending, setPending] = useState<PendingSummary | null>(null);
  const [reverifySelected, setReverifySelected] = useState(false);
  // Key handling reads the selection from a ref so a synchronous DOWN then ENTER
  // observes the new row before React re-renders the captured handler.
  const reverifyRef = useRef(false);

  const dismiss = (target: PendingSummary): void => {
    reverifyRef.current = false; setReverifySelected(false);
    void dismissSummary(target.revision);
    setPending(null);
    resetChoice();
  };
  const handleInput = (target: PendingSummary, key: Key, register: (revision: number) => Promise<void>): boolean => {
    // The reverify row exists only while the saved registration is pending verification.
    // Arrows walk approve → reverify(optional) → continue; ENTER sends the row selected.current/reverifyRef point at.
    if (key.upArrow || key.downArrow) {
      if (reverifyAvailable) {
        if (reverifyRef.current) {
          reverifyRef.current = false; setReverifySelected(false);
          selected.current = key.upArrow;
        } else if (key.downArrow) {
          reverifyRef.current = true; setReverifySelected(true); selected.current = false;
        } else {
          selected.current = true;
        }
        setApprove(selected.current);
        return true;
      }
      selected.current = key.upArrow;
      setApprove(selected.current);
      return true;
    }
    if (key.return) {
      const wasReverify = reverifyRef.current;
      reverifyRef.current = false; setReverifySelected(false);
      if (wasReverify) void reverify(target.revision);
      else if (selected.current) void register(target.revision);
      else dismiss(target);
      return true;
    }
    if (key.escape) { dismiss(target); return true; }
    // Typing resumes conversation and leaves the summary unavailable to UI approval.
    dismiss(target);
    return false;
  };

  return { pending, setPending, dismiss, handleInput, reverifySelected };
}
