#!/usr/bin/env bash
# One-time Google Cloud setup for the sync server (docs/operations.md →
# "Google Cloud"). Run it in Cloud Shell; safe to run again.
#
#   bash setup-gcp.sh <project-id> [github-owner/repo]
#
# Asks for the Neon connection string, then prints the repository
# variables the Server workflow needs.
set -euo pipefail

PROJECT="${1:?usage: setup-gcp.sh <project-id> [github-owner/repo]}"
REPO="${2:-Sarrdai/NoteDown}"
REGION="${REGION:-europe-west1}"
API_SA="notedown-api@$PROJECT.iam.gserviceaccount.com"
DEPLOY_SA="notedown-deploy@$PROJECT.iam.gserviceaccount.com"

gcloud config set project "$PROJECT"
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com

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
read -rsp "Neon connection string (postgresql://…): " database_url; echo
printf %s "$database_url" | put_secret notedown-database-url
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

cat <<EOF

Done. Add these repository variables in GitHub
(Settings → Secrets and variables → Actions → Variables):

  GCP_PROJECT_ID    $PROJECT
  GCP_REGION        $REGION
  GCP_WIF_PROVIDER  $pool/providers/notedown
EOF
