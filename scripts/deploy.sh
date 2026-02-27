#!/usr/bin/env bash
set -euo pipefail

# Deploys dist/ to GitHub Pages (gh-pages branch) and updates Route53 DNS.
#
# Default domain is nfl.rprtd.app (override via DOMAIN=...).
# Expected DNS model:
# - DOMAIN is a subdomain (e.g. nfl.rprtd.app), so Route53 uses CNAME
# - CNAME points to <github-user>.github.io

DOMAIN="${DOMAIN:-nfl.rprtd.app}"
ROUTE53_ZONE_NAME="${ROUTE53_ZONE_NAME:-}"
GITHUB_REMOTE="${GITHUB_REMOTE:-origin}"
GH_PAGES_BRANCH="${GH_PAGES_BRANCH:-gh-pages}"
GH_PAGES_TARGET="${GH_PAGES_TARGET:-}"
REPO_ROOT="$(pwd)"

if [[ -z "${ROUTE53_ZONE_NAME}" ]]; then
  # If DOMAIN has 3+ labels, default zone is parent (e.g. nfl.rprtd.app -> rprtd.app)
  if [[ "${DOMAIN}" == *.*.* ]]; then
    ROUTE53_ZONE_NAME="${DOMAIN#*.}"
  else
    ROUTE53_ZONE_NAME="${DOMAIN}"
  fi 
fi

for cmd in git aws npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done

if [[ ! -d "dist" ]]; then
  echo "dist/ not found, building..."
  npm run build
fi

REMOTE_URL="$(git remote get-url "${GITHUB_REMOTE}")"
OWNER_REPO="$(printf '%s' "${REMOTE_URL}" | sed -E 's#^git@github.com:##; s#^https://github.com/##; s#\.git$##')"
GH_OWNER="$(printf '%s' "${OWNER_REPO}" | cut -d/ -f1)"
GH_REPO="$(printf '%s' "${OWNER_REPO}" | cut -d/ -f2)"
if [[ -z "${GH_OWNER}" || -z "${GH_REPO}" || "${GH_OWNER}" == "${GH_REPO}" ]]; then
  echo "Could not parse GitHub owner/repo from remote '${GITHUB_REMOTE}': ${REMOTE_URL}"
  exit 1
fi

if [[ -z "${GH_PAGES_TARGET}" ]]; then
  GH_PAGES_TARGET="${GH_OWNER}.github.io"
fi

# Allow convenience input like "owner/repo" and normalize to the required DNS host.
if [[ "${GH_PAGES_TARGET}" == */* ]]; then
  GH_PAGES_TARGET="${GH_PAGES_TARGET%%/*}.github.io"
fi

echo "Deploy config:"
echo "  DOMAIN=${DOMAIN}"
echo "  GITHUB_REMOTE=${GITHUB_REMOTE}"
echo "  GH_PAGES_BRANCH=${GH_PAGES_BRANCH}"
echo "  GH_OWNER=${GH_OWNER}"
echo "  GH_REPO=${GH_REPO}"
echo "  GH_PAGES_TARGET=${GH_PAGES_TARGET}"
echo "  ROUTE53_ZONE_NAME=${ROUTE53_ZONE_NAME}"
echo "  MODE=github-pages+route53"

echo "Publishing dist/ to GitHub Pages branch (${GH_PAGES_BRANCH})..."
TMP_WT="$(mktemp -d)"
cleanup() {
  git worktree remove "${TMP_WT}" --force >/dev/null 2>&1 || true
  rm -rf "${TMP_WT}"
}
trap cleanup EXIT

git worktree prune >/dev/null 2>&1 || true
EXISTING_WT_PATH="$(git worktree list --porcelain | awk -v b="refs/heads/${GH_PAGES_BRANCH}" '
  $1=="worktree" { wt=$2 }
  $1=="branch" && $2==b { print wt }
')"
if [[ -n "${EXISTING_WT_PATH}" ]]; then
  echo "Removing existing ${GH_PAGES_BRANCH} worktree at ${EXISTING_WT_PATH} ..."
  git worktree remove "${EXISTING_WT_PATH}" --force >/dev/null 2>&1 || true
  git worktree prune >/dev/null 2>&1 || true
fi

if git ls-remote --exit-code --heads "${GITHUB_REMOTE}" "${GH_PAGES_BRANCH}" >/dev/null 2>&1; then
  git fetch "${GITHUB_REMOTE}" "${GH_PAGES_BRANCH}:${GH_PAGES_BRANCH}" >/dev/null 2>&1 || true
  git worktree add "${TMP_WT}" "${GH_PAGES_BRANCH}" >/dev/null
else
  git worktree add --detach "${TMP_WT}" >/dev/null
  (
    cd "${TMP_WT}"
    git checkout --orphan "${GH_PAGES_BRANCH}" >/dev/null
    git reset --hard >/dev/null
  )
fi

(
  cd "${TMP_WT}"
  find . -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
  cp -R "${REPO_ROOT}/dist/." .
  printf '%s\n' "${DOMAIN}" > CNAME
  : > .nojekyll

  git add -A
  if git diff --staged --quiet; then
    echo "No changes to publish on ${GH_PAGES_BRANCH}."
  else
    git commit -m "Deploy ${DOMAIN} $(date -u +'%Y-%m-%dT%H:%M:%SZ')" >/dev/null
    git push "${GITHUB_REMOTE}" "${GH_PAGES_BRANCH}:${GH_PAGES_BRANCH}" >/dev/null
    echo "Pushed updated site to ${GITHUB_REMOTE}/${GH_PAGES_BRANCH}."
  fi
)

HOSTED_ZONE_ID="$(aws route53 list-hosted-zones-by-name \
  --dns-name "${ROUTE53_ZONE_NAME}" \
  --query "HostedZones[?Name=='${ROUTE53_ZONE_NAME}.'] | [0].Id" \
  --output text | sed 's|/hostedzone/||')"

if [[ -z "${HOSTED_ZONE_ID}" || "${HOSTED_ZONE_ID}" == "None" ]]; then
  echo "Could not find Route53 hosted zone '${ROUTE53_ZONE_NAME}.'"
  exit 1
fi

TMP_JSON="$(mktemp)"
trap 'rm -f "${TMP_JSON}"' EXIT

cat >"${TMP_JSON}" <<JSON
{
  "Comment": "Deploy ${DOMAIN} to GitHub Pages",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "${GH_PAGES_TARGET}"}]
      }
    }
  ]
}
JSON

echo "Updating Route53 CNAME to GitHub Pages (${GH_PAGES_TARGET}) ..."
aws route53 change-resource-record-sets \
  --hosted-zone-id "${HOSTED_ZONE_ID}" \
  --change-batch "file://${TMP_JSON}" >/dev/null

echo "Deploy complete: https://${DOMAIN}"
echo "If this repo is not already configured for GitHub Pages, set Pages source to branch '${GH_PAGES_BRANCH}' (root)."
