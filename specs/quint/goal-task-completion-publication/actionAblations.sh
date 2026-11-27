#!/bin/sh
# Action ablations for goalTaskCompletionPublication.qnt.
# Each probe edits one action body in a copy of the model (the guard helpers and DESIGN flags stay
# as they are), then runs safety, quiescentDelivery, and drainedDelivery on the `fixed` instance.
# Every probe must produce a `[violation]` line in at least one of its runs and every quint
# command must finish without an error; `[ok]`-only output or a failed command makes this script
# exit non-zero.
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

# Prints the result of one command. Returns 0 when it printed a `[violation]` line (the expected
# outcome of an ablation), 1 when quint failed without one, and 2 when it only printed `[ok]`.
probe() { # label command...
  label=$1
  shift
  printf '%s: ' "$label"
  status=0
  output=$(quint run "$@" 2>&1) || status=$?
  violations=$(printf '%s\n' "$output" | grep -E '^\[violation\]' || true)
  if [ -n "$violations" ]; then
    printf '%s\n' "$violations"
    return 0
  fi
  if [ "$status" -ne 0 ]; then
    printf 'quint failed (exit %s) without a [violation] line\n' "$status"
    return 1
  fi
  printf 'no [violation] line\n'
  printf '%s\n' "$output" | grep -E '^\[ok\]' || true
  return 2
}

patch p1 '      republisherAccepts(DESIGN, rec),
      daemon'"'"' = { phase: DaemonRead' '      republisherAccepts(DESIGN, rec),
      false,
      daemon'"'"' = { phase: DaemonRead'
patch p2 '    if (goal == Aborted or goal == Deleted) all {
      inbox'"'"' = inbox,' '    if (true) all {
      inbox'"'"' = inbox,'
patch p3 '    tasks'"'"' = applyClearPending(tasks, usesStaleDeletionRecovery(DESIGN), DESIGN, daemon.task, daemon.attempt),' '    tasks'"'"' = tasks,'

# Each control passes when at least one of its three properties reports a violation and no quint
# invocation fails. `safety` and `quiescentDelivery` are expected to stay `[ok]` for P1 and P3
# (README), so requiring a violation from every property would make the script always fail.
failed=0
for probe_name in p1 p2 p3; do
  file="$work/$probe_name/goalTaskCompletionPublication.qnt"
  violations_found=0
  command_failed=0
  for invariant in safety quiescentDelivery; do
    result=0
    probe "$probe_name $invariant" "$file" --main fixed --invariant "$invariant" \
      --max-samples 10000 --max-steps 20 --seed 0x2a || result=$?
    if [ "$result" -eq 0 ]; then violations_found=1; fi
    if [ "$result" -eq 1 ]; then command_failed=1; fi
  done
  result=0
  probe "$probe_name drainedDelivery" "$file" --main fixed --init initD --step stepD --invariant drainedDelivery \
    --max-samples 5000 --max-steps 70 --seed 0x2a || result=$?
  if [ "$result" -eq 0 ]; then violations_found=1; fi
  if [ "$result" -eq 1 ]; then command_failed=1; fi
  if [ "$command_failed" -ne 0 ] || [ "$violations_found" -eq 0 ]; then
    printf '%s: failed (quint error or no [violation] line in any property)\n' "$probe_name"
    failed=1
  else
    printf '%s: ok (at least one [violation] line)\n' "$probe_name"
  fi
done

exit "$failed"
