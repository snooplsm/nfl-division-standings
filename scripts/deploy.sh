#!/usr/bin/env bash
set -euo pipefail

# Deploys dist/ to S3 and updates Route53 for a custom domain.
#
# Default domain here is nfl.rprtd.app (override via DOMAIN=...).
# If you use nfl.rptd.app, run with DOMAIN=nfl.rptd.app.
#
# Modes:
# 1) CloudFront mode (recommended): set CLOUDFRONT_DISTRIBUTION_ID.
#    - Uploads to S3 bucket
#    - Upserts Route53 A/AAAA ALIAS to CloudFront
#    - Creates CloudFront invalidation
#
# 2) S3 website mode (fallback): no CLOUDFRONT_DISTRIBUTION_ID set.
#    - Requires BUCKET == DOMAIN
#    - Configures bucket website + public-read policy
#    - Upserts Route53 A ALIAS to S3 website endpoint (HTTP only)

DOMAIN="${DOMAIN:-nfl.rprtd.app}"
BUCKET="${BUCKET:-${DOMAIN}}"
AWS_REGION="${AWS_REGION:-us-east-1}"
CLOUDFRONT_DISTRIBUTION_ID="${CLOUDFRONT_DISTRIBUTION_ID:-}"
ROUTE53_ZONE_NAME="${ROUTE53_ZONE_NAME:-}"

if [[ -z "${ROUTE53_ZONE_NAME}" ]]; then
  # If DOMAIN has 3+ labels, default zone is parent (e.g. nfl.rprtd.app -> rprtd.app)
  if [[ "${DOMAIN}" == *.*.* ]]; then
    ROUTE53_ZONE_NAME="${DOMAIN#*.}"
  else
    ROUTE53_ZONE_NAME="${DOMAIN}"
  fi
fi

for cmd in aws npm; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd"
    exit 1
  fi
done

if [[ ! -d "dist" ]]; then
  echo "dist/ not found, building..."
  npm run build
fi

echo "Deploy config:"
echo "  DOMAIN=${DOMAIN}"
echo "  BUCKET=${BUCKET}"
echo "  AWS_REGION=${AWS_REGION}"
echo "  ROUTE53_ZONE_NAME=${ROUTE53_ZONE_NAME}"
if [[ -n "${CLOUDFRONT_DISTRIBUTION_ID}" ]]; then
  echo "  MODE=cloudfront (${CLOUDFRONT_DISTRIBUTION_ID})"
else
  echo "  MODE=s3-website"
fi

if ! aws s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  echo "Bucket ${BUCKET} not found, creating..."
  if [[ "${AWS_REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${BUCKET}"
  else
    aws s3api create-bucket \
      --bucket "${BUCKET}" \
      --create-bucket-configuration "LocationConstraint=${AWS_REGION}"
  fi
fi

echo "Uploading files to s3://${BUCKET} ..."
aws s3 sync dist "s3://${BUCKET}" \
  --delete \
  --exclude "index.html" \
  --cache-control "public,max-age=31536000,immutable"

aws s3 cp dist/index.html "s3://${BUCKET}/index.html" \
  --cache-control "public,max-age=60,must-revalidate" \
  --content-type "text/html; charset=utf-8"

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

if [[ -n "${CLOUDFRONT_DISTRIBUTION_ID}" ]]; then
  CF_DOMAIN="$(aws cloudfront get-distribution --id "${CLOUDFRONT_DISTRIBUTION_ID}" --query 'Distribution.DomainName' --output text)"

  cat >"${TMP_JSON}" <<JSON
{
  "Comment": "Deploy ${DOMAIN} to CloudFront",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "${CF_DOMAIN}",
          "EvaluateTargetHealth": false
        }
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}",
        "Type": "AAAA",
        "AliasTarget": {
          "HostedZoneId": "Z2FDTNDATAQYW2",
          "DNSName": "${CF_DOMAIN}",
          "EvaluateTargetHealth": false
        }
      }
    }
  ]
}
JSON

  echo "Updating Route53 records to CloudFront (${CF_DOMAIN}) ..."
  aws route53 change-resource-record-sets \
    --hosted-zone-id "${HOSTED_ZONE_ID}" \
    --change-batch "file://${TMP_JSON}" >/dev/null

  echo "Creating CloudFront invalidation..."
  aws cloudfront create-invalidation \
    --distribution-id "${CLOUDFRONT_DISTRIBUTION_ID}" \
    --paths "/*" >/dev/null

  echo "Deploy complete: https://${DOMAIN}"
else
  if [[ "${BUCKET}" != "${DOMAIN}" ]]; then
    echo "S3 website mode requires BUCKET == DOMAIN."
    echo "Current BUCKET=${BUCKET}, DOMAIN=${DOMAIN}."
    echo "Set CLOUDFRONT_DISTRIBUTION_ID for bucket/domain mismatch."
    exit 1
  fi

  aws s3 website "s3://${BUCKET}" \
    --index-document index.html \
    --error-document index.html

  aws s3api put-public-access-block \
    --bucket "${BUCKET}" \
    --public-access-block-configuration \
      BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false

  cat >"${TMP_JSON}" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": ["s3:GetObject"],
      "Resource": ["arn:aws:s3:::${BUCKET}/*"]
    }
  ]
}
JSON

  aws s3api put-bucket-policy \
    --bucket "${BUCKET}" \
    --policy "file://${TMP_JSON}"

  S3_WEBSITE_DNS="${BUCKET}.s3-website-${AWS_REGION}.amazonaws.com"

  # Fallback: use simple CNAME if alias-zone lookup is unavailable for your partition/region.
  cat >"${TMP_JSON}" <<JSON
{
  "Comment": "Deploy ${DOMAIN} to S3 website",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "${DOMAIN}",
        "Type": "CNAME",
        "TTL": 300,
        "ResourceRecords": [{"Value": "${S3_WEBSITE_DNS}"}]
      }
    }
  ]
}
JSON

  echo "Updating Route53 CNAME to S3 website (${S3_WEBSITE_DNS}) ..."
  aws route53 change-resource-record-sets \
    --hosted-zone-id "${HOSTED_ZONE_ID}" \
    --change-batch "file://${TMP_JSON}" >/dev/null

  echo "Deploy complete (HTTP): http://${DOMAIN}"
fi
