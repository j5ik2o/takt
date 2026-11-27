#!/bin/sh
# Action ablations for goalTaskCompletionPublication.qnt.
# Each probe edits one action body in a copy of the model (the guard helpers and DESIGN flags stay
# as they are), then runs safety, quiescentDelivery, and drainedDelivery on the `fixed` instance.
#
#   P1  daemonReadPending never fires (adds `false` to its guard; republisherAccepts is unchanged)
#   P2  daemonPublishOk clears the mark without writing the inbox (always takes the Aborted branch)
#   P3  daemonClearOk keeps the mark (tasks' = tasks)
#
# Usage: sh actionAblations.sh [work-dir]   (default: a new mktemp directory)
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=${1:-$(mktemp -d)}
mkdir -p "$work"

patch() { # name old new
  mkdir -p "$work/$1"
  python3 -I - "$here/goalTaskCompletionPublication.qnt" "$work/$1/goalTaskCompletionPublication.qnt" "$2" "$3" <<'EOF'
import sys
src, dst, old, new = sys.argv[1:]
text = open(src).read()
if text.count(old) != 1:
    sys.exit(f"pattern must occur exactly once: {old!r}")
open(dst, "w").write(text.replace(old, new))
EOF
}

patch p1 '      republisherAccepts(DESIGN, rec),
      daemon'"'"' = { phase: DaemonRead' '      republisherAccepts(DESIGN, rec),
      false,
      daemon'"'"' = { phase: DaemonRead'
patch p2 '    if (goal == Aborted or goal == Deleted) all {
      inbox'"'"' = inbox,' '    if (true) all {
      inbox'"'"' = inbox,'
patch p3 '    tasks'"'"' = applyClearPending(tasks, usesStaleDeletionRecovery(DESIGN), DESIGN, daemon.task, daemon.attempt),' '    tasks'"'"' = tasks,'

for probe in p1 p2 p3; do
  file="$work/$probe/goalTaskCompletionPublication.qnt"
  for invariant in safety quiescentDelivery; do
    printf '%s %s: ' "$probe" "$invariant"
    quint run "$file" --main fixed --invariant "$invariant" \
      --max-samples 10000 --max-steps 20 --seed 0x2a 2>&1 | grep -E '^\[(ok|violation)\]' || true
  done
  printf '%s drainedDelivery: ' "$probe"
  quint run "$file" --main fixed --init initD --step stepD --invariant drainedDelivery \
    --max-samples 5000 --max-steps 70 --seed 0x2a 2>&1 | grep -E '^\[(ok|violation)\]' || true
done
