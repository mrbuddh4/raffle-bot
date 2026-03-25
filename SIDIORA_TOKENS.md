# Sidiora.fun Token Support in Raffle Bot

## Overview

The Raffle Bot fully supports Sidiora.fun tokens as raffle rewards. Sidiora.fun is a launchpad AMM protocol for USDL-paired markets on HyperPaxeer, and any token launched through Sidiora can be used for raffles just like any other ERC20 token.

## What is Sidiora.fun?

Sidiora.fun is a modular launchpad AMM protocol designed specifically for USDL-paired markets on HyperPaxeer. Key features include:

- **Market Creation**: Launch new tokens paired with USDL in a single transaction
- **AMM Pricing**: Automatic market maker pricing for fair token discovery
- **Fee Strategies**: Multiple fee models (CLAIM, BURN, AIRDROP, LP_REWARDS)
- **Optical Hooks**: Extensible plugin system for custom swap logic

Learn more: https://github.com/Paxeer-Network/Sidiora.fun-Protocol

## Using Sidiora Tokens in Raffles

### How to Set Up a Sidiora Token Raffle

1. **In Telegram Bot**: Select "Custom Token (ERC20)" when creating a raffle
2. **Enter Token Name**: Provide the token symbol (e.g., "LAUNCH", "MYSID")
3. **Enter Contract Address**: Paste the Sidiora token contract address (0x... format)
   - This is the token address deployed by the Sidiora Factory
4. **Set Reward Amount**: Specify total tokens to distribute among winners

### Example: Launching a LAUNCH Token Raffle

```
Step 5/7 - Reward Type: Select "🪙 Custom Token (ERC20)"
Step 6/7 - Token Name: "LAUNCH"
Step 6.5/7 - Token CA: "0xabcd...1234" (contract address from Sidiora)
Step 7/7 - Total Reward: "1000" (1000 LAUNCH tokens total)
```

## Technical Details

### Token Address Format

Sidiora tokens are deployed using `CREATE2` with deterministic addresses. The token address can be found:

1. **From Sidiora Router**: Call `createMarket()` and parse the `MarketCreated` event
2. **From PoolRegistry**: Query pool listings on Paxeer chain
3. **From Block Explorer**: Search for the Sidiora Factory creation transactions

Example event parsing:
```javascript
// MarketCreated(token, pool, creator, nftId)
const tokenAddress = event.args[0];  // This is what you need
```

### Supported Networks

- **Primary**: HyperPaxeer (Paxeer Network)
- **RPC**: Configure via `EVM_RPC_URL` environment variable
- **Other EVM Chains**: Any Sidiora deployment on an EVM chain is supported

### Auto-Payout Behavior

When a raffle with Sidiora tokens closes:

1. Winners are drawn automatically
2. **Auto-payout** transfers the token rewards directly to winner wallets
3. Winners see transaction links (e.g., `[Tx](paxscan.io/tx/...)`
4. If auto-payout fails, use **Forced Pay** option to manually trigger payouts

```typescript
// Internally, the bot uses:
await payoutService.payoutToken(
  'hyperpaxeer',              // or other chain
  '0xabcd...',                // Sidiora token address
  amountPerWinner,
  winnersAddresses,
  signerPrivateKey
);
```

## Common Sidiora Token Addresses

To find your Sidiora token address, you can:

1. **Check Telegram Bot History**: Previous raffle confirmations show the address
2. **Use Paxscan**: Search for your token name on https://paxscan.io/
3. **Sidiora Registry**: Check the poolRegistry for all launched pools
4. **Creation Signature**: Look for your `RouterMarketCreated` event

## Troubleshooting

### "Token address is not valid" Error

- Ensure the address starts with `0x` and is 42 characters long
- Verify it's a valid Ethereum address format
- Check that it's a Sidiora token on the correct network (HyperPaxeer)

### Auto-Payout Fails for Sidiora Token

- Verify admin wallet has approvals for the token
- Check token decimals (Sidiora tokens are typically 6 decimals)
- Ensure sufficient gas on the chain
- Use "Forced Pay" as fallback

### Token Decimals Issue

Sidiora tokens created through the factory use **6 decimals** by default (like USDL). The bot auto-detects decimals via contract calls, so this should be transparent.

## Future Enhancements

Potential integrations not yet implemented:

- **Direct Pool Queries**: Fetch token price, liquidity, volume from Sidiora pools
- **Market Creation**: Create Sidiora markets directly from bot
- **Fee Strategy Selection**: Choose fee models at raffle creation
- **Pool Stats Display**: Show current pool stats in raffle info

To enable these, set:
```env
SIDIORA_ROUTER_ADDRESS=0x...  # Mainnet Router address
```

## API Reference

### PayoutService - EVM Token Payout

```typescript
async payoutToken(
  chain: WalletChain,        // 'hyperpaxeer', 'ethereum', etc
  tokenAddress: string,      // Sidiora token contract address
  amount: number,            // Amount per winner
  targets: Array<{
    rank: number,
    walletAddress: string
  }>,
  signerSecret: string       // Admin payout wallet private key
): Promise<PayoutResult[]>
```

**Returns**: Array of transactions with `txHash` for each winner

## Support

Need help with Sidiora tokens in the bot?

1. Check this documentation
2. Review Sidiora protocol docs: https://github.com/Paxeer-Network/Sidiora.fun-Protocol
3. Open an issue in the raffle-bot repository

## See Also

- [Paxeer Network](https://paxeer.eth.limo/)
- [Sidiora.fun Protocol Docs](https://github.com/Paxeer-Network/Sidiora.fun-Protocol)
- [HyperPaxeer Block Explorer](https://paxscan.io/)
