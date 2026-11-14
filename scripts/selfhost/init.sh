#!/usr/bin/env bash
# First-run setup for a self-hosted DeerDawn.
#
# Writes .env at the repo root from .env.selfhost.example, generating every
# secret with openssl. Never overwrites an existing .env.
#
# Usage:
#   ./scripts/selfhost/init.sh                       # interactive (asks about the LLM)
#   ./scripts/selfhost/init.sh --non-interactive     # defaults, no prompts
#   ./scripts/selfhost/init.sh --domain deerdawn.example.com
#   ./scripts/selfhost/init.sh --llm ollama|openai|openrouter|skip [--llm-key KEY] [--llm-model MODEL]
#   ./scripts/selfhost/init.sh --port 3000
#   ./scripts/selfhost/init.sh --env-file PATH       # write somewhere other than ./.env
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TEMPLATE="$ROOT/.env.selfhost.example"
ENV_FILE="$ROOT/.env"

DOMAIN=""
LLM_CHOICE=""
LLM_KEY=""
LLM_MODEL_ARG=""
PORT=""
INTERACTIVE=1
[ -t 0 ] || INTERACTIVE=0

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:?--domain needs a value}"; shift 2 ;;
    --llm) LLM_CHOICE="${2:?--llm needs a value}"; shift 2 ;;
    --llm-key) LLM_KEY="${2:?--llm-key needs a value}"; shift 2 ;;
    --llm-model) LLM_MODEL_ARG="${2:?--llm-model needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --env-file) ENV_FILE="${2:?--env-file needs a value}"; shift 2 ;;
    --non-interactive|-y) INTERACTIVE=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

die() { echo "init.sh: $*" >&2; exit 1; }

command -v openssl >/dev/null 2>&1 || die "openssl is required to generate secrets."
[ -f "$TEMPLATE" ] || die "missing $TEMPLATE (run this from a DeerDawn checkout)."

if [ -e "$ENV_FILE" ]; then
  echo "init.sh: $ENV_FILE already exists; leaving it untouched."
  echo "         Delete or move it first if you really want a fresh one (and keep its"
  echo "         ENCRYPTION_MASTER_KEY: existing data cannot be read without it)."
  exit 0
fi

if [ -n "$DOMAIN" ] && ! printf '%s' "$DOMAIN" | grep -Eq '^[A-Za-z0-9.-]+$'; then
  die "--domain takes a bare hostname such as deerdawn.example.com"
fi
if [ -n "$PORT" ] && ! printf '%s' "$PORT" | grep -Eq '^[0-9]+$'; then
  die "--port takes a number"
fi

# ── LLM provider ─────────────────────────────────────────────────────────────
if [ -z "$LLM_CHOICE" ] && [ "$INTERACTIVE" = 1 ]; then
  echo "Which LLM should DeerDawn use to extract decisions and tasks from sessions?"
  echo "  1) OpenAI       (needs an API key)"
  echo "  2) Ollama       (local, on this machine, no key)"
  echo "  3) OpenRouter   (needs an API key)"
  echo "  4) Decide later (edit LLM_* in .env)"
  printf "Choice [1]: "
  read -r answer || answer=""
  case "${answer:-1}" in
    1) LLM_CHOICE=openai ;;
    2) LLM_CHOICE=ollama ;;
    3) LLM_CHOICE=openrouter ;;
    *) LLM_CHOICE=skip ;;
  esac
  if [ "$LLM_CHOICE" = openai ] || [ "$LLM_CHOICE" = openrouter ]; then
    if [ -z "$LLM_KEY" ]; then
      printf "API key (input hidden, Enter to add it later): "
      read -rs LLM_KEY || LLM_KEY=""
      echo
    fi
  fi
fi
LLM_CHOICE="${LLM_CHOICE:-skip}"

LLM_URL="https://api.openai.com/v1"
LLM_MODEL="gpt-4o-mini"
case "$LLM_CHOICE" in
  openai) ;;
  ollama) LLM_URL="http://host.docker.internal:11434/v1"; LLM_MODEL="llama3.1"; LLM_KEY="" ;;
  openrouter) LLM_URL="https://openrouter.ai/api/v1"; LLM_MODEL="openai/gpt-4o-mini" ;;
  skip) ;;
  *) die "--llm must be one of: openai, ollama, openrouter, skip" ;;
esac
[ -n "$LLM_MODEL_ARG" ] && LLM_MODEL="$LLM_MODEL_ARG"

# ── Secrets ──────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD="$(openssl rand -hex 24)"
JWT_SECRET="$(openssl rand -hex 48)"
DEERDAWN_SYSTEM_API_KEY="$(openssl rand -hex 32)"
ENCRYPTION_MASTER_KEY="$(openssl rand -hex 32)"

# ── Write .env ───────────────────────────────────────────────────────────────
umask 077
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# Replace KEY=... on the first uncommented line for KEY; append if absent.
set_var() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$TMP"; then
    awk -v k="$key" -v v="$value" 'BEGIN{done=0} { if (!done && index($0, k"=")==1) { print k"="v; done=1 } else print }' "$TMP" > "$TMP.next"
    mv "$TMP.next" "$TMP"
  else
    printf '%s=%s\n' "$key" "$value" >> "$TMP"
  fi
}

cp "$TEMPLATE" "$TMP"
set_var POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_var JWT_SECRET "$JWT_SECRET"
set_var DEERDAWN_SYSTEM_API_KEY "$DEERDAWN_SYSTEM_API_KEY"
set_var ENCRYPTION_MASTER_KEY "$ENCRYPTION_MASTER_KEY"
set_var LLM_API_URL "$LLM_URL"
set_var LLM_API_KEY "$LLM_KEY"
set_var LLM_MODEL "$LLM_MODEL"

if [ -n "$PORT" ]; then
  set_var DEERDAWN_HTTP_PORT "$PORT"
  set_var DEERDAWN_PUBLIC_URL "http://localhost:$PORT"
fi

if [ -n "$DOMAIN" ]; then
  {
    echo ""
    echo "# HTTPS mode (written by init.sh --domain)"
    echo "COMPOSE_FILE=docker-compose.yml:infra/selfhost/docker-compose.https.yml"
    echo "DEERDAWN_DOMAIN=$DOMAIN"
  } >> "$TMP"
  set_var DEERDAWN_PUBLIC_URL "https://$DOMAIN"
fi

grep -q "__GENERATE__" "$TMP" && die "a secret placeholder was left unfilled; .env not written."
mv "$TMP" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"

PUBLIC_URL="$(grep '^DEERDAWN_PUBLIC_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"

cat <<EOF

Wrote $ENV_FILE (mode 600).

========================================================================
  BACK UP YOUR ENCRYPTION_MASTER_KEY NOW.

  Everything DeerDawn stores is encrypted with it. If this key is lost,
  every encrypted brief is PERMANENTLY unreadable, and a database backup
  is useless without it. Copy it into a password manager or secrets vault,
  somewhere other than this machine:

    ENCRYPTION_MASTER_KEY=$ENCRYPTION_MASTER_KEY
========================================================================

Next:
  docker compose up -d
  open $PUBLIC_URL and sign up: the first account becomes the owner.

LLM: $LLM_CHOICE ($LLM_URL, model $LLM_MODEL)$( [ "$LLM_CHOICE" != ollama ] && [ -z "$LLM_KEY" ] && printf '\n     No API key set yet: add LLM_API_KEY to .env, then docker compose up -d.' )
Guide: docs/self-hosting.md
EOF
