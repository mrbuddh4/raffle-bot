# Telegram Airdrop / Raffle Bot (EVM + Solana)

A Telegram bot for running raffles with PostgreSQL-backed registration data.

## Features

- User profile supports storing both EVM and Solana wallets.
- Returning users can tap **Enter** for future raffles without re-entering wallet details.
- Admin-only raffle creation with configurable winner count and chain (`evm` or `solana`).
- Admin controls are scoped to the admin's own raffles only.
- Winners are selected automatically at random in real time when entry target is reached (no manual winner picking).
- Animated countdown draw UX.
- Random winner selection and payout wallet export.
- Admin CSV upload to bulk add entries.
- Per-admin payout signer configuration (each admin can set their own payout wallet by chain/mode).
- Payout tracking (`pending` / `paid` + tx hash).
- Optional on-chain payout execution for native coins and tokens (ERC-20 + SPL).
- **Sidiora.fun token support** — Any Sidiora.fun-launched token can be used as a raffle reward. See [SIDIORA_TOKENS.md](./SIDIORA_TOKENS.md) for details.
- Timed raffle lifecycle alerts in group chat (go-live, hourly countdown reminders, and close/winner announcement).
- Group onboarding: when added to a group, the bot posts usage instructions.
- Group-safe UX: profile/wallet registration and edits are DM-only for privacy.

## Setup

1. Copy `.env.example` to `.env`.
2. Fill required values:
   - `TELEGRAM_BOT_TOKEN`
   - `DATABASE_URL`
   - `ADMIN_IDS` (comma-separated Telegram numeric IDs)
  - RPC endpoints: `EVM_RPC_URL`, `SOLANA_RPC_URL`
  - Optional global fallback payout signers (used only when admin-specific signer is not configured):
    - `EVM_PAYOUT_PRIVATE_KEY`
    - `SOLANA_PAYOUT_SECRET_KEY`
    - `EVM_TOKEN_PAYOUT_PRIVATE_KEY`
    - `SOLANA_TOKEN_PAYOUT_SECRET_KEY`
  - Optional announcement links/media:
    - `REGISTRATION_LINK` (fallback register/join URL)
    - `FUNDING_LINK` (optional “Get Funded” URL shown in announcements)
    - `RAFFLE_ARTWORK_URL` (optional image URL sent with go-live alert)
    - `TELEGRAM_BOT_USERNAME` (used to build `https://t.me/<username>?start=register` when `REGISTRATION_LINK` is not set)
3. Install dependencies:

```bash
npm install
```

4. Run in development:

```bash
npm run dev
```

5. Build + start production:

```bash
npm run build
npm start
```

## Deploy (GitHub + Railway)

1. Push this project to GitHub:

```bash
git init
git add .
git commit -m "Initial raffle bot"
git branch -M main
git remote add origin <YOUR_GITHUB_REPO_URL>
git push -u origin main
```

2. In Railway:
  - Create a new project from your GitHub repo.
  - Add a PostgreSQL service.
  - Set all required bot env vars in the app service (`TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `ADMIN_IDS`, RPC URLs, payout keys as needed).
  - Optional alert vars: `REGISTRATION_LINK`, `FUNDING_LINK`, `RAFFLE_ARTWORK_URL`, `TELEGRAM_BOT_USERNAME`.

3. Deploy settings:
  - `railway.json` already sets build/start commands (`npm run build`, `npm start`).
  - On first deploy, confirm logs show migrations run and bot startup succeeds.

4. Important:
  - Run only one bot instance to avoid Telegram polling `409 Conflict` errors.
  - In Railway, keep replicas at 1 for this polling bot.

## Commands

### User

- `/start` – open main menu.
- `/myid` – show your Telegram user ID.
- `/profile` – edit username or a single wallet without full re-registration.
- `/register` – register/update username + chain + wallet.
- Run `/register` once per chain (`evm` and `solana`) to save both wallets.
- `/enter` – enter all open raffles that match your saved wallet chain.

### Group Behavior

- When the bot is added to a group, it posts a short onboarding message.
- In groups, only admins can use bot commands.
- In groups, admins can use `/enter` to join open raffles.
- `/currentraffles` shows active raffles plus register/funding links.
- `/register` and `/profile` are DM-only (wallet/profile data stays out of group chat).

### Admin

- `/admin` – open admin panel.
- `/myraffles` – list your recent raffles (owner-scoped).
- `/setpayout` – set your payout wallet signer for a chain + mode (`native` or `token`).
- `/removepayout` – remove your payout wallet signer for a chain + mode.
- `/currentraffles` – show active raffles and quick links in group/private chats.
  - Admin panel also includes a `My Raffles` button for the same owner-scoped list.
  - Admin panel includes a `Set Payout Wallet` button.
  - Admin panel includes a `Remove Payout Wallet` button.
  - Create raffle
  - Generate payout wallet list
  - Execute on-chain payout (`native` or `token` mode)
  - Mark winner paid
  - Upload CSV entries
- Admin users can still use normal user actions (`/register`, `/enter`) to participate in raffles.
- Admin panel actions only affect raffles created by that admin account.
- Raffle creation now asks for duration in hours; end time drives scheduled reminders/closure messaging.

### Admin Onboarding

1. Run `/myid` in the bot chat.
2. Copy the numeric ID returned.
3. Add it to `ADMIN_IDS` in `.env` (comma-separated for multiple admins).
4. Restart the bot.

## CSV Upload

Upload as Telegram **document** (CSV) after clicking `Upload CSV` in admin panel.

Required header names:

```csv
username,wallet_address,chain,telegram_username
```

`chain` and `telegram_username` are optional. If `chain` is omitted, active raffle chain is used.

## Notes

- Wallet validation supports both EVM (`0x` + 40 hex chars) and Solana public keys.
- On startup, migration `migrations/001_init.sql` is auto-run.

## Payout Execution Notes

- `Execute On-chain Payout` asks for `native` or `token` mode.
- Payout execution uses the calling admin's configured signer for the selected chain + mode.
- `native` mode pays each winner the same native coin amount.
- `token` mode pays each winner the same ERC-20 or SPL token amount.
- EVM token mode uses token contract address and resolves decimals automatically.
- Solana token mode uses mint address and resolves decimals automatically.
- Bot shows a payout preview and requires typing `CONFIRM` before broadcasting transactions.
- Use a dedicated hot wallet with limited funds and strict access controls.
