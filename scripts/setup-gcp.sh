#!/usr/bin/env bash
# One-time Google Cloud setup for the sync server (docs/operations.md →
# "Google Cloud"). Run it in Cloud Shell; safe to run again.
#
#   bash setup-gcp.sh <project-id> [github-owner/repo]
#
# Asks for the Neon connection string, then prints the repository
# variables the Server workflow needs. Once the server is deployed, a
# second run also sets up the uptime check and the error alert; it asks
# for the email address that gets the alerts (or set ALERT_EMAIL).
set -euo pipefail

PROJECT="${1:?usage: setup-gcp.sh <project-id> [github-owner/repo]}"
REPO="${2:-Sarrdai/NoteDown}"
REGION="${REGION:-europe-west1}"
API_SA="notedown-api@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="notedown-deploy@$PROJECT.iam.gserviceaccount.com"

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  monitoring.googleapis.com

echo "== Image registry (keeps the 5 newest images, free tier is 0.5 GB)"
gcloud artifacts repositories describe notedown --location "$REGION" >/dev/null 2>&1 ||
  gcloud artifacts repositories create notedown --repository-format docker --location "$REGION"
policy=$(mktemp)
cat > "$policy" <<'EOF'
[{"name": "keep-newest", "action": {"type": "Keep"}, "mostRecentVersions": {"keepCount": 5}},
 {"name": "delete-rest", "action": {"type": "Delete"}, "condition": {"olderThan": "1d"}}]
EOF
gcloud artifacts repositories set-cleanup-policies notedown --location "$REGION" \
  --policy "$policy" --no-dry-run

echo "== Service accounts"
for sa in notedown-api notedown-deploy; do
  gcloud iam service-accounts describe "$sa@$PROJECT.iam.gserviceaccount.com" >/dev/null 2>&1 ||
    gcloud iam service-accounts create "$sa"
done

echo "== Secrets"
put_secret() {  # name, value on stdin
  if gcloud secrets describe "$1" >/dev/null 2>&1; then
    gcloud secrets versions add "$1" --data-file=-
  else
    gcloud secrets create "$1" --data-file=-
  fi
  gcloud secrets add-iam-policy-binding "$1" --member "serviceAccount:$API_SA" \
    --role roles/secretmanager.secretAccessor >/dev/null
}
if gcloud secrets describe notedown-database-url >/dev/null 2>&1; then
  read -rsp "Neon connection string (postgresql://…, Enter keeps the stored one): " database_url; echo
else
  read -rsp "Neon connection string (postgresql://…): " database_url; echo
fi
if [ -n "$database_url" ]; then
  printf %s "$database_url" | put_secret notedown-database-url
fi
if ! gcloud secrets describe notedown-server-secret >/dev/null 2>&1; then
  openssl rand -base64 32 | tr -d '\n' | put_secret notedown-server-secret
fi

echo "== Deploy rights for GitHub Actions"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$DEPLOY_SA" \
  --role roles/run.admin --condition None >/dev/null
gcloud artifacts repositories add-iam-policy-binding notedown --location "$REGION" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/artifactregistry.writer >/dev/null
gcloud iam service-accounts add-iam-policy-binding "$API_SA" \
  --member "serviceAccount:$DEPLOY_SA" --role roles/iam.serviceAccountUser >/dev/null

echo "== Workload identity federation (only main of $REPO may deploy)"
gcloud iam workload-identity-pools describe github --location global >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools create github --location global --display-name GitHub
gcloud iam workload-identity-pools providers describe notedown --location global \
  --workload-identity-pool github >/dev/null 2>&1 ||
  gcloud iam workload-identity-pools providers create-oidc notedown --location global \
    --workload-identity-pool github --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping "google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition "assertion.repository == '$REPO' && assertion.ref == 'refs/heads/main'"
pool=$(gcloud iam workload-identity-pools describe github --location global --format 'value(name)')
gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/$pool/attribute.repository/$REPO" >/dev/null

echo "== Uptime check and error alert"
put_policy() {  # display name, policy JSON on stdin; creates or replaces the policy
  local file existing
  file=$(mktemp)
  cat > "$file"
  existing=$(gcloud monitoring policies list --filter "display_name=\"$1\"" --format 'value(name)' | head -n1)
  if [ -n "$existing" ]; then
    gcloud monitoring policies update "$existing" --policy-from-file "$file" >/dev/null
  else
    gcloud monitoring policies create --policy-from-file "$file" >/dev/null
  fi
}
api_url=$(gcloud run services describe notedown-api --region "$REGION" \
  --format 'value(status.url)' 2>/dev/null || true)
if [ -z "$api_url" ]; then
  echo "The server is not deployed yet: run this script again after the first deploy."
else
  email="${ALERT_EMAIL:-}"
  [ -n "$email" ] || read -rp "Email address for alerts: " email
  channel=$(gcloud beta monitoring channels list --type email \
    --filter "labels.email_address=\"$email\"" --format 'value(name)' | head -n1)
  [ -n "$channel" ] || channel=$(gcloud beta monitoring channels create --type email \
    --display-name "NoteDown owner" --channel-labels "email_address=$email" --format 'value(name)')
  # /health/live doesn't touch the database, so Neon can still sleep.
  check=$(gcloud monitoring uptime list-configs --filter 'display_name="notedown-api live"' \
    --format 'value(name)' | head -n1)
  [ -n "$check" ] || check=$(gcloud monitoring uptime create "notedown-api live" \
    --resource-type uptime-url --resource-labels "host=${api_url#https://},project_id=$PROJECT" \
    --protocol https --path /health/live --period 5 --timeout 10 \
    --regions europe,usa-iowa,usa-virginia \
    --matcher-type contains-string --matcher-content '"ok":true' --format 'value(name)')
  # Down: the check fails from more than one region for 5 minutes.
  put_policy "NoteDown server down" <<JSON
{"displayName": "NoteDown server down", "combiner": "OR", "notificationChannels": ["$channel"],
 "conditions": [{"displayName": "Uptime check fails", "conditionThreshold": {
   "filter": "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type=\"uptime_url\" AND metric.label.check_id=\"${check##*/}\"",
   "aggregations": [{"alignmentPeriod": "1200s", "perSeriesAligner": "ALIGN_NEXT_OLDER",
     "crossSeriesReducer": "REDUCE_COUNT_FALSE", "groupByFields": ["resource.label.host"]}],
   "comparison": "COMPARISON_GT", "thresholdValue": 1, "duration": "300s",
   "trigger": {"count": 1}}}]}
JSON
  # Errors: 3 or more 5xx responses within 10 minutes, e.g. while the database is down.
  put_policy "NoteDown server errors" <<JSON
{"displayName": "NoteDown server errors", "combiner": "OR", "notificationChannels": ["$channel"],
 "conditions": [{"displayName": "5xx responses", "conditionThreshold": {
   "filter": "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"notedown-api\" AND metric.label.response_code_class=\"5xx\"",
   "aggregations": [{"alignmentPeriod": "600s", "perSeriesAligner": "ALIGN_SUM",
     "crossSeriesReducer": "REDUCE_SUM", "groupByFields": ["resource.label.service_name"]}],
   "comparison": "COMPARISON_GT", "thresholdValue": 2, "duration": "0s",
   "trigger": {"count": 1}}}]}
JSON
  echo "Alerts go to $email."
fi

cat <<EOF

Done. Add these repository variables in GitHub
(Settings → Secrets and variables → Actions → Variables):

  GCP_PROJECT_ID    $PROJECT
  GCP_REGION        $REGION
  GCP_WIF_PROVIDER  $pool/providers/notedown
EOF
