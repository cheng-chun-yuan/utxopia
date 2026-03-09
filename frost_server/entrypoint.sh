#!/bin/sh
if [ -n "$FROST_KEY_JSON" ] && [ -n "$SIGNER_ID" ]; then
  printf "%s" "$FROST_KEY_JSON" > /app/config/signer${SIGNER_ID}.key.enc
  echo "Key file written for signer ${SIGNER_ID} ($(wc -c < /app/config/signer${SIGNER_ID}.key.enc) bytes)"
elif [ -n "$FROST_KEY_BASE64" ] && [ -n "$SIGNER_ID" ]; then
  printf "%s" "$FROST_KEY_BASE64" | base64 -d > /app/config/signer${SIGNER_ID}.key.enc 2>&1
  echo "Key file written for signer ${SIGNER_ID} ($(wc -c < /app/config/signer${SIGNER_ID}.key.enc) bytes)"
fi
# If no args passed, build command from env vars
if [ $# -eq 0 ] && [ -n "$SIGNER_ID" ]; then
  BIND_PORT=${PORT:-9001}
  exec /app/frost-server run \
    --bind "0.0.0.0:${BIND_PORT}" \
    --id "${SIGNER_ID}" \
    --password "${FROST_KEY_PASSWORD:-test}" \
    --network "${FROST_NETWORK:-testnet4}"
else
  exec /app/frost-server "$@"
fi
