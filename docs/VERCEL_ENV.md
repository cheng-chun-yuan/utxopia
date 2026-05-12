# Vercel Environment Variables

Copy these into the Vercel dashboard (Project → Settings → Environment Variables) for the Production environment. Repeat for Preview/Development with the same values unless noted.

## Public (`NEXT_PUBLIC_*`) — exposed to the browser bundle

| Key | Value |
| --- | --- |
| `NEXT_PUBLIC_NETWORK` | `devnet` |
| `NEXT_PUBLIC_BACKEND_API_URL` | `https://api.utxopia.com` |
| `NEXT_PUBLIC_UTXOPIA_PROGRAM_ID` | `G1bj9Vw9ipZ2Z7zKa9HrcHHPNqeWjg7uu51TsDr3ixUy` |
| `NEXT_PUBLIC_ZKBTC_MINT` | `CDqY9mTzbWma7GzCULTJMMZzyVothKEXtr7AnXdpD6v8` |
| `NEXT_PUBLIC_BTC_NETWORK` | `testnet4` |
| `NEXT_PUBLIC_SOLANA_RPC_URL` | `https://api.devnet.solana.com` |
| `NEXT_PUBLIC_CIRCUIT_CDN_URL` | `/circuits` |

## Server-side (no `NEXT_PUBLIC_` prefix) — never exposed to the browser

| Key | Value | Notes |
| --- | --- | --- |
| `BACKEND_API_URL` | `https://api.utxopia.com` | Used by Next.js server routes (SSR / API routes). |
| `BACKEND_API_KEY` | `<the secret from local .env>` | Must match the backend's `BACKEND_API_KEY`. Mark as **Sensitive** in Vercel. |

## Optional

| Key | Value | When to set |
| --- | --- | --- |
| `NEXT_PUBLIC_HELIUS_API_KEY` | `<your-helius-key>` | Better RPC reliability. Free tier works for devnet. |
| `HELIUS_API_KEY` | same | Used by server routes. |

## After saving

1. Click **Redeploy** in the Vercel dashboard, or push any commit to `main` and Vercel rebuilds automatically.
2. Backend CORS already accepts `https://utxopia.com`, `https://www.utxopia.com`, `https://app.utxopia.com`. If you point a custom domain that isn't on this list, update `ALLOWED_ORIGIN` in `docker-compose.backend.yml` and restart the backend container.

## Quick verification

```bash
curl -sS https://api.utxopia.com/api/tree/status
# expect: {"root":"...", "size":N, "synced":true}
```

## How the URLs flow

```
Browser ──► https://<your-vercel-domain>          (Vercel-hosted Next.js)
                                                  │
                                                  ▼
                                  NEXT_PUBLIC_BACKEND_API_URL
                                                  │
                                                  ▼
                  https://api.utxopia.com (Cloudflare proxy)
                                                  │
                                                  ▼
                       utxopia-cloudflared (Docker, locally)
                                                  │
                                                  ▼
                       backend:3001 (utxopia-backend container)
                                                  │
                                                  ▼
                           Solana devnet + Bitcoin testnet4
```
