import { Pool } from 'pg';
import { WalletChain } from '../utils/validators';

export type PayoutMode = 'native' | 'token';

export interface AdminPayoutWallet {
  adminTelegramUserId: number;
  chain: WalletChain;
  mode: PayoutMode;
  tokenAddress: string | null;
  secret: string;
  walletAddress: string;
}

export class AdminPayoutWalletService {
  constructor(private readonly pool: Pool) {}

  async upsertWallet(input: {
    adminTelegramUserId: number;
    chain: WalletChain;
    mode: PayoutMode;
    tokenAddress?: string | null;
    secret: string;
    walletAddress: string;
  }): Promise<void> {
    await this.pool.query(
      `
      INSERT INTO admin_payout_wallets (admin_telegram_user_id, chain, mode, token_address, secret, wallet_address)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (admin_telegram_user_id, chain, mode)
      DO UPDATE SET
        token_address = EXCLUDED.token_address,
        secret = EXCLUDED.secret,
        wallet_address = EXCLUDED.wallet_address,
        updated_at = NOW()
      `,
      [input.adminTelegramUserId, input.chain, input.mode, input.tokenAddress ?? null, input.secret, input.walletAddress]
    );
  }

  async getWallet(adminTelegramUserId: number, chain: WalletChain, mode: PayoutMode): Promise<AdminPayoutWallet | null> {
    const result = await this.pool.query(
      `
      SELECT admin_telegram_user_id, chain, mode, token_address, secret, wallet_address
      FROM admin_payout_wallets
      WHERE admin_telegram_user_id = $1
        AND chain = $2
        AND mode = $3
      LIMIT 1
      `,
      [adminTelegramUserId, chain, mode]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapWallet(result.rows[0]);
  }

  async listWallets(adminTelegramUserId: number): Promise<AdminPayoutWallet[]> {
    const result = await this.pool.query(
      `
      SELECT admin_telegram_user_id, chain, mode, token_address, secret, wallet_address
      FROM admin_payout_wallets
      WHERE admin_telegram_user_id = $1
      ORDER BY chain ASC, mode ASC
      `,
      [adminTelegramUserId]
    );

    return result.rows.map((row) => this.mapWallet(row));
  }

  async deleteWallet(adminTelegramUserId: number, chain: WalletChain, mode: PayoutMode): Promise<boolean> {
    const result = await this.pool.query(
      `
      DELETE FROM admin_payout_wallets
      WHERE admin_telegram_user_id = $1
        AND chain = $2
        AND mode = $3
      `,
      [adminTelegramUserId, chain, mode]
    );

    return (result.rowCount ?? 0) > 0;
  }

  private mapWallet(row: any): AdminPayoutWallet {
    return {
      adminTelegramUserId: Number(row.admin_telegram_user_id),
      chain: row.chain,
      mode: row.mode,
      tokenAddress: row.token_address ?? null,
      secret: row.secret,
      walletAddress: row.wallet_address,
    };
  }
}
