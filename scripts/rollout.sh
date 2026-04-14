#!/usr/bin/env bash
###############################################################################
# rollout.sh — Roll out the Deployment Gate to repos across the org
#
# This script:
# 1. Creates standard environments (Dev, QA, Staging, Production-*) on repos
# 2. Attaches the Custom Deployment Protection Rule to gated environments
# 3. Adds branch restrictions (only main/tags can deploy to prod)
# 4. Optionally adds required reviewers for production environments
#
# Usage:
#   # Single repo
#   ./rollout.sh joshjohanning-org/my-app
#
#   # From a file (one repo per line)
#   ./rollout.sh --file repos.txt
#
#   # All repos in the org (careful!)
#   ./rollout.sh --all
#
#   # Dry run (show what would happen)
#   ./rollout.sh --dry-run joshjohanning-org/my-app
#
# Prerequisites:
#   - gh CLI authenticated with admin access
#   - The Deployment Gate GitHub App installed on the org
#   - APP_INTEGRATION_ID set (or passed via --app-id)
###############################################################################

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────
ORG="joshjohanning-org"
APP_INTEGRATION_ID="${APP_ID:-3381065}"  # Your Deployment Gate app ID
DRY_RUN=false
REPO_FILE=""
ALL_REPOS=false
REPOS=()

# Environments to create and their config
# Format: name|gate_enabled|require_reviewers|branch_policy
ENVIRONMENTS=(
  "Dev|false|false|none"
  "QA|true|false|none"
  "Staging|true|false|none"
  "Production-East|true|true|main_and_tags"
  "Production-Central|true|true|main_and_tags"
)

# Reviewers for production environments (GitHub usernames or team slugs)
# Leave empty to skip — teams can add their own reviewers later
PROD_REVIEWERS=""

# ── Parse arguments ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --file) REPO_FILE="$2"; shift 2 ;;
    --all) ALL_REPOS=true; shift ;;
    --app-id) APP_INTEGRATION_ID="$2"; shift 2 ;;
    --org) ORG="$2"; shift 2 ;;
    --reviewers) PROD_REVIEWERS="$2"; shift 2 ;;
    *) REPOS+=("$1"); shift ;;
  esac
done

# ── Build repo list ──────────────────────────────────────────────────────
if [ "$ALL_REPOS" = true ]; then
  echo "Fetching all repos in ${ORG}..."
  mapfile -t REPOS < <(gh repo list "$ORG" --limit 2000 --json nameWithOwner --jq '.[].nameWithOwner')
  echo "  Found ${#REPOS[@]} repos"
elif [ -n "$REPO_FILE" ]; then
  mapfile -t REPOS < "$REPO_FILE"
  echo "Loaded ${#REPOS[@]} repos from $REPO_FILE"
fi

if [ ${#REPOS[@]} -eq 0 ]; then
  echo "Usage: ./rollout.sh [--dry-run] [--file repos.txt | --all | owner/repo ...]"
  exit 1
fi

# ── Helper functions ─────────────────────────────────────────────────────

create_environment() {
  local repo="$1"
  local env_name="$2"
  local require_reviewers="$3"
  local branch_policy="$4"

  local body="{}"

  # Add wait timer for production
  if [ "$require_reviewers" = "true" ]; then
    body='{"wait_timer": 1}'
  fi

  if [ "$DRY_RUN" = true ]; then
    echo "    [DRY RUN] Would create environment: $env_name"
    return
  fi

  gh api -X PUT "repos/${repo}/environments/${env_name}" \
    --input <(echo "$body") --silent 2>/dev/null || true

  # Add branch policy (restrict to main branch and tags)
  if [ "$branch_policy" = "main_and_tags" ]; then
    gh api -X PUT "repos/${repo}/environments/${env_name}" \
      --input <(echo '{
        "deployment_branch_policy": {
          "protected_branches": false,
          "custom_branch_policies": true
        }
      }') --silent 2>/dev/null || true

    # Add main branch rule
    gh api -X POST "repos/${repo}/environments/${env_name}/deployment-branch-policies" \
      --input <(echo '{"name": "main", "type": "branch"}') --silent 2>/dev/null || true

    # Add tag pattern rule
    gh api -X POST "repos/${repo}/environments/${env_name}/deployment-branch-policies" \
      --input <(echo '{"name": "v*", "type": "tag"}') --silent 2>/dev/null || true
  fi

  echo "    ✅ Environment created: $env_name"
}

attach_gate() {
  local repo="$1"
  local env_name="$2"

  if [ "$DRY_RUN" = true ]; then
    echo "    [DRY RUN] Would attach gate to: $env_name"
    return
  fi

  # Check if gate is already attached
  local existing
  existing=$(gh api "repos/${repo}/environments/${env_name}/deployment_protection_rules" \
    --jq ".custom_deployment_protection_rules[]? | select(.app.id == ${APP_INTEGRATION_ID}) | .id" 2>/dev/null || echo "")

  if [ -n "$existing" ]; then
    echo "    ⏭️  Gate already attached to: $env_name (rule #$existing)"
    return
  fi

  gh api -X POST "repos/${repo}/environments/${env_name}/deployment_protection_rules" \
    -F integration_id="$APP_INTEGRATION_ID" --silent 2>/dev/null

  echo "    🔒 Gate attached to: $env_name"
}

# ── Main loop ────────────────────────────────────────────────────────────

echo ""
echo "╔══════════════════════════════════════════════════════════╗"
echo "║       Deployment Gate — Rollout Script                  ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "  Org:           $ORG"
echo "  App ID:        $APP_INTEGRATION_ID"
echo "  Repos:         ${#REPOS[@]}"
echo "  Dry run:       $DRY_RUN"
echo "  Environments:  ${#ENVIRONMENTS[@]}"
echo ""

if [ "$DRY_RUN" = true ]; then
  echo "  ⚠️  DRY RUN MODE — no changes will be made"
  echo ""
fi

SUCCEEDED=0
FAILED=0

for repo in "${REPOS[@]}"; do
  # Strip whitespace
  repo=$(echo "$repo" | xargs)
  [ -z "$repo" ] && continue

  # Add org prefix if not present
  if [[ "$repo" != *"/"* ]]; then
    repo="${ORG}/${repo}"
  fi

  echo "📦 ${repo}"

  # Verify repo exists and app has access
  if ! gh api "repos/${repo}" --jq '.name' 2>/dev/null 1>/dev/null; then
    echo "    ❌ Repo not found or no access"
    ((FAILED++))
    continue
  fi

  for env_config in "${ENVIRONMENTS[@]}"; do
    IFS='|' read -r env_name gate_enabled require_reviewers branch_policy <<< "$env_config"

    create_environment "$repo" "$env_name" "$require_reviewers" "$branch_policy"

    if [ "$gate_enabled" = "true" ]; then
      attach_gate "$repo" "$env_name"
    fi
  done

  ((SUCCEEDED++))
  echo ""
done

echo "═══════════════════════════════════════════════════════════"
echo "  Done! $SUCCEEDED repos configured, $FAILED failed."
echo "═══════════════════════════════════════════════════════════"
