# zVault Frontend

Next.js 16 app for the privacy BTC-to-Solana bridge.

## Quick Start

```bash
bun install
bun dev
# Open http://localhost:3000
```

## Structure

```
src/
├── app/                    # Next.js pages
├── components/
│   └── btc-widget/       # Main widget (deposit/withdraw/activity)
├── hooks/                  # Custom hooks (note storage, etc.)
└── lib/
    ├── api/                # API client
    ├── crypto/             # Taproot address generation
    └── zVault/      # ZK proof generation
```

## Key Components

| Component | Purpose |
|-----------|---------|
| `widget.tsx` | Tab container (deposit/withdraw/activity) |
| `deposit-flow.tsx` | Multi-step BTC deposit |
| `withdraw-flow.tsx` | BTC withdrawal interface |
| `balance-view.tsx` | Activity and address lookup |

## Config

Create `.env.local`:

```env
NEXT_PUBLIC_zkBTC_API_URL=http://localhost:8080
NEXT_PUBLIC_SOLANA_RPC=https://api.devnet.solana.com
NEXT_PUBLIC_PROGRAM_ID=4yUhu6Cg7fGimyY9ZQpMpkshQUnPX6WaVyauDbuEGjoT
```

## Features

- Solana wallet integration (Phantom)
- QR codes for deposit addresses
- Real-time status polling (mempool.space)
- Client-side ZK proof generation (snarkjs)
- Local note storage (localStorage)

## Testing

```bash
bun test        # Run tests
bun test --ui   # With UI
```

## Tech

- Next.js 16 + React 19
- Tailwind CSS
- @solana/wallet-adapter
- snarkjs for ZK proofs
