#!/usr/bin/env bash
# PreToolUse guard: deny tool calls that touch ~/.ssh or the Firefox profile dir.
# Applies to Read/Edit/Write/NotebookEdit/Glob/Grep (path field) and Bash (substring scan).
set -euo pipefail

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')

deny() {
  jq -nc --arg reason "$1" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
  exit 0
}

home="$HOME"
ssh_abs="$home/.ssh"
ff_abs="$home/Library/Application Support/Firefox"

# Match a literal path string against guarded prefixes (handles abs + ~/-style).
path_blocked() {
  local p="$1"
  [[ -z "$p" ]] && return 1
  # Intentionally match literal tildes for tool inputs that may not expand $HOME.
  # shellcheck disable=SC2088
  case "$p" in
    "$ssh_abs"|"$ssh_abs"/*) return 0 ;;
    "$ff_abs"|"$ff_abs"/*) return 0 ;;
    "~/.ssh"|"~/.ssh/"*) return 0 ;;
    "~/Library/Application Support/Firefox"|"~/Library/Application Support/Firefox/"*) return 0 ;;
  esac
  return 1
}

case "$tool" in
  Read|Edit|Write|NotebookEdit)
    p=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
    if path_blocked "$p"; then
      deny "Blocked: '$p' is under a guarded directory (~/.ssh or Firefox profile). Use a synthetic fixture instead."
    fi
    ;;
  Glob|Grep)
    p=$(printf '%s' "$input" | jq -r '.tool_input.path // empty')
    if path_blocked "$p"; then
      deny "Blocked: search path '$p' falls under a guarded directory (~/.ssh or Firefox profile)."
    fi
    ;;
  Bash)
    cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')
    # Substring scan on the raw command. Catches ~/, $HOME/, /Users/<name>/.
    if printf '%s' "$cmd" | grep -qE '(^|[^A-Za-z0-9_])(~|\$\{?HOME\}?|/Users/[^/[:space:]]+)/\.ssh($|/|"|'\'')'; then
      deny "Blocked: command references ~/.ssh. Use a synthetic fixture; do not read SSH keys or config."
    fi
    if printf '%s' "$cmd" | grep -qE 'Library/Application[\\ ]+Support/Firefox'; then
      deny "Blocked: command references the Firefox profile directory. Use a synthetic places.sqlite fixture."
    fi
    ;;
esac

exit 0
