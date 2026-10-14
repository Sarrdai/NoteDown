#!/usr/bin/env bash
# Checks the host variables of the deploy workflows (docs/operations.md):
# each given name must hold a bare host name, e.g. notedown-api.example.org —
# no scheme, path or port, and not the documentation's example.com
# placeholder. An unset variable passes; the workflows skip what needs it.
#
#   API_HOST=… WEB_HOST=… scripts/check-host.sh API_HOST WEB_HOST
set -euo pipefail
status=0
for name in "$@"; do
  value="${!name:-}"
  [ -z "$value" ] && continue
  if [[ "$value" == *example.com* ]]; then
    echo "::error::$name is still the placeholder '$value' from docs/operations.md; set the real host name."
    status=1
  elif ! [[ "$value" =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$ ]]; then
    echo "::error::$name must be a bare host name like notedown-api.example.org (no https://, path or port), not '$value'."
    status=1
  fi
done
exit $status
