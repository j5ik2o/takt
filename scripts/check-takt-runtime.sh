#!/bin/sh
# Check, before a run, that `takt` on PATH is the fork build a project expects.
# See docs/shared-takt-switch.md ("run の前の確認").
#
# Usage: check-takt-runtime.sh [--root DIR] [--key KEY]... [--repo DIR --contains SHA]
#   --root      install that `takt` must resolve to (default: $HOME/local/takt-custom)
#   --key       project config key the build must accept (repeatable; default: task_finish_hook)
#   --repo      git checkout of the fork, used with --contains
#   --contains  commit that DEPLOYED_FROM_COMMIT must include
# Exit 0 when every check passes, 1 when one fails, 2 on a usage error.

set -u

root="$HOME/local/takt-custom"
keys=""
repo=""
contains=""

usage() {
  sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || usage; root=$2; shift 2 ;;
    --key) [ $# -ge 2 ] || usage; keys="$keys $2"; shift 2 ;;
    --repo) [ $# -ge 2 ] || usage; repo=$2; shift 2 ;;
    --contains) [ $# -ge 2 ] || usage; contains=$2; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done
[ -n "$keys" ] || keys=" task_finish_hook"
if [ -n "$contains" ] && [ -z "$repo" ]; then
  echo "--contains needs --repo" >&2
  usage
fi

failed=0
ok() { echo "ok: $*"; }
ng() { echo "NG: $*"; failed=1; }

real_dir() { (cd "$1" 2>/dev/null && pwd -P); }
real_file() {
  dir=$(real_dir "$(dirname "$1")") || return 1
  path="$dir/$(basename "$1")"
  if [ -L "$path" ]; then
    target=$(readlink "$path")
    case "$target" in /*) ;; *) target="$dir/$target" ;; esac
    real_file "$target"
  else
    echo "$path"
  fi
}

root_real=$(real_dir "$root") || { echo "NG: $root does not exist"; exit 1; }

# 1. PATH resolves `takt` to this install.
resolved=$(command -v takt) || resolved=""
if [ -z "$resolved" ]; then
  ng "takt is not on PATH"
elif [ "$(real_file "$resolved")" = "$(real_file "$root/bin/takt")" ]; then
  ok "takt on PATH is $resolved -> $root_real/bin/takt"
else
  ng "takt on PATH is $resolved ($(real_file "$resolved")), expected $root/bin/takt ($root_real/bin/takt)"
fi

# 2. The build accepts the keys in a project's .takt/config.yaml (ProjectConfigSchema, not global-only keys).
schema="$root_real/dist/core/models/config-schemas.js"
project_keys=$(node --input-type=module -e '
  const { ProjectConfigSchema } = await import(process.argv[1]);
  console.log(Object.keys(ProjectConfigSchema.shape).join("\n"));
' "$schema" 2>/dev/null) || project_keys=""
if [ -z "$project_keys" ]; then
  ng "cannot read the project config keys from $schema"
fi
for key in $keys; do
  if printf '%s\n' "$project_keys" | grep -qx "$key"; then
    ok "$schema accepts project key $key"
  elif [ -n "$project_keys" ]; then
    ng "$schema does not accept project key $key"
  fi
done

# 3. The build was deployed from a known commit.
deployed_file="$root_real/DEPLOYED_FROM_COMMIT"
deployed=$(cat "$deployed_file" 2>/dev/null | tr -d '[:space:]')
if [ -z "$deployed" ]; then
  ng "$deployed_file is missing or empty"
else
  short=${root_real##*/takt-custom-}
  if [ "$short" != "$root_real" ]; then
    case "$deployed" in
      "$short"*) ok "DEPLOYED_FROM_COMMIT $deployed matches directory $root_real" ;;
      *) ng "DEPLOYED_FROM_COMMIT $deployed does not match directory $root_real" ;;
    esac
  else
    ok "DEPLOYED_FROM_COMMIT is $deployed"
  fi
  if [ -n "$contains" ]; then
    if git -C "$repo" merge-base --is-ancestor "$contains" "$deployed" 2>/dev/null; then
      ok "$deployed contains $contains"
    else
      ng "$deployed does not contain $contains (checked in $repo; fetch first if either commit is missing)"
    fi
  fi
fi

exit $failed
