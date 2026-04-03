#!/bin/sh
if [ -n "$FROST_KEY_JSON" ] && [ -n "$SIGNER_ID" ]; then
  printf "%s" "$FROST_KEY_JSON" > /app/config/signer${SIGNER_ID}.key.enc
  echo "Key file written for signer ${SIGNER_ID} ($(wc -c < /app/config/signer${SIGNER_ID}.key.enc) bytes)"
elif [ -n "$FROST_KEY_BASE64" ] && [ -n "$SIGNER_ID" ]; then
  printf "%s" "$FROST_KEY_BASE64" | base64 -d > /app/config/signer${SIGNER_ID}.key.enc 2>&1
  echo "Key file written for signer ${SIGNER_ID} ($(wc -c < /app/config/signer${SIGNER_ID}.key.enc) bytes)"
fi
# If no args passed, build command from env vars
# Note: clap auto-reads FROST_ESPLORA_URL, FROST_POOL_ADDRESS, FROST_MAX_AMOUNT,
#   FROST_MAX_FEE, FROST_AUDIT_LOG, FROST_SOLANA_RPC_URL, FROST_PRIVACY_COIN_PROGRAM_ID
#   directly from env vars — no need to pass them as flags.
if [ $# -eq 0 ] && [ -n "$SIGNER_ID" ]; then
  BIND_PORT=${PORT:-9001}
  CMD="/app/frost-server run \
    --bind 0.0.0.0:${BIND_PORT} \
    --id ${SIGNER_ID} \
    --password ${FROST_KEY_PASSWORD:-test} \
    --network ${FROST_NETWORK:-testnet4}"

  # --require-context is a bool flag, only add when env is set
  [ -n "$FROST_REQUIRE_CONTEXT" ] && CMD="$CMD --require-context"

  exec $CMD
else
  exec /app/frost-server "$@"
fi
