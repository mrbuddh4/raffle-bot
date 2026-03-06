import { Pool } from 'pg';
import { WalletChain } from '../utils/validators';

export interface Raffle {
  id: number;
  title: string;
  winnerCount: number;
  allEntrantsWin: boolean;
  chain: WalletChain;
  status: 'created' | 'open' | 'drawing' | 'completed';
  createdBy: number;
  announcementChatId: number | null;
  endsAt: Date | null;
  nextHourlyAlertAt: Date | null;
  rewardToken: string | null;
  rewardTotalAmount: number | null;
}

export interface WinnerResult {
  rank: number;
  displayUsername: string;
  walletChain: WalletChain;
  walletAddress: string;
  userId: number;
}

export interface WonRaffleSummary {
  id: number;
  title: string;
  status: 'created' | 'open' | 'drawing' | 'completed';
  chain: WalletChain;
  rank: number;
  rewardToken: string | null;
  rewardTotalAmount: number | null;
  winnerTotal: number;
  payoutStatus: 'pending' | 'paid';
  payoutTxHash: string | null;
  completedAt: Date | null;
}

export interface EnteredRaffleSummary {
  id: number;
  title: string;
  status: 'created' | 'open' | 'drawing' | 'completed';
  chain: WalletChain;
  winnerCount: number;
  allEntrantsWin: boolean;
  endsAt: Date | null;
  enteredAt: Date;
}

export class RaffleService {
  constructor(private readonly pool: Pool) {}

  async createRaffle(
    title: string,
    winnerCount: number,
    allEntrantsWin: boolean,
    chain: WalletChain,
    createdBy: number,
    announcementChatId: number,
    durationHours: number,
    rewardToken: string,
    rewardTotalAmount: number
  ): Promise<Raffle> {
    await this.pool.query(
      `
      UPDATE raffles
      SET status = 'completed', completed_at = NOW()
      WHERE status IN ('created', 'open', 'drawing')
        AND created_by = $1
      `,
      [createdBy]
    );

    const result = await this.pool.query(
      `
      INSERT INTO raffles (
        title,
        winner_count,
        chain,
        status,
        created_by,
        announcement_chat_id,
        all_entrants_win,
        opened_at,
        ends_at,
        next_hourly_alert_at,
        reward_token,
        reward_total_amount
      )
      VALUES (
        $1,
        $2,
        $3,
        'open',
        $4,
        $5,
        $6,
        NOW(),
        NOW() + make_interval(hours => $7),
        NOW() + INTERVAL '10 minutes',
        $8,
        $9
      )
      RETURNING id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      `,
      [title, winnerCount, chain, createdBy, announcementChatId, allEntrantsWin, durationHours, rewardToken, rewardTotalAmount]
    );

    return this.mapRaffle(result.rows[0]);
  }

  async getActiveRaffle(): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status IN ('created', 'open', 'drawing')
      ORDER BY id DESC
      LIMIT 1
      `
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async getRaffleById(raffleId: number): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE id = $1
      LIMIT 1
      `,
      [raffleId]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async claimOpenRaffleForDrawing(raffleId: number): Promise<boolean> {
    const result = await this.pool.query(
      `
      UPDATE raffles
      SET status = 'drawing'
      WHERE id = $1
        AND status = 'open'
      `,
      [raffleId]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getActiveRaffleByCreator(createdBy: number): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status IN ('created', 'open', 'drawing')
        AND created_by = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [createdBy]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async cancelActiveRaffleByCreator(createdBy: number): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      UPDATE raffles
      SET status = 'completed', completed_at = NOW()
      WHERE id = (
        SELECT id
        FROM raffles
        WHERE status IN ('created', 'open', 'drawing')
          AND created_by = $1
        ORDER BY id DESC
        LIMIT 1
      )
      RETURNING id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      `,
      [createdBy]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async getOpenRaffles(): Promise<Raffle[]> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status IN ('created', 'open', 'drawing')
      ORDER BY id DESC
      `
    );

    return result.rows.map((row) => this.mapRaffle(row));
  }

  async getRafflesByCreator(createdBy: number, limit = 10): Promise<Raffle[]> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE created_by = $1
      ORDER BY id DESC
      LIMIT $2
      `,
      [createdBy, limit]
    );

    return result.rows.map((row) => this.mapRaffle(row));
  }

  async getRafflesWonByUser(userId: number, limit = 20): Promise<WonRaffleSummary[]> {
    const result = await this.pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.status,
        r.chain,
        r.reward_token,
        r.reward_total_amount,
        r.completed_at,
        rw.rank,
        rw.payout_status,
        rw.payout_tx_hash,
        (
          SELECT COUNT(*)::int
          FROM raffle_winners rw2
          WHERE rw2.raffle_id = r.id
        ) AS winner_total
      FROM raffle_winners rw
      INNER JOIN raffles r ON r.id = rw.raffle_id
      WHERE rw.user_id = $1
      ORDER BY COALESCE(r.completed_at, r.created_at) DESC, rw.rank ASC
      LIMIT $2
      `,
      [userId, limit]
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      status: row.status,
      chain: row.chain,
      rank: Number(row.rank),
      rewardToken: row.reward_token ?? null,
      rewardTotalAmount: row.reward_total_amount != null ? Number(row.reward_total_amount) : null,
      winnerTotal: Number(row.winner_total),
      payoutStatus: row.payout_status,
      payoutTxHash: row.payout_tx_hash ?? null,
      completedAt: row.completed_at ? new Date(row.completed_at) : null,
    }));
  }

  async getRafflesEnteredByUser(userId: number, limit = 20): Promise<EnteredRaffleSummary[]> {
    const result = await this.pool.query(
      `
      SELECT
        r.id,
        r.title,
        r.status,
        r.chain,
        r.winner_count,
        r.all_entrants_win,
        r.ends_at,
        e.entered_at
      FROM raffle_entries e
      INNER JOIN raffles r ON r.id = e.raffle_id
      WHERE e.user_id = $1
      ORDER BY e.entered_at DESC
      LIMIT $2
      `,
      [userId, limit]
    );

    return result.rows.map((row) => ({
      id: Number(row.id),
      title: row.title,
      status: row.status,
      chain: row.chain,
      winnerCount: Number(row.winner_count),
      allEntrantsWin: Boolean(row.all_entrants_win),
      endsAt: row.ends_at ? new Date(row.ends_at) : null,
      enteredAt: new Date(row.entered_at),
    }));
  }

  async getLastCompletedRaffleId(): Promise<number | null> {
    const result = await this.pool.query(`SELECT id FROM raffles WHERE status = 'completed' ORDER BY id DESC LIMIT 1`);

    if (result.rowCount === 0) {
      return null;
    }

    return Number(result.rows[0].id);
  }

  async getLastCompletedRaffleIdByCreator(createdBy: number): Promise<number | null> {
    const result = await this.pool.query(
      `
      SELECT id
      FROM raffles
      WHERE status = 'completed'
        AND created_by = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [createdBy]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return Number(result.rows[0].id);
  }

  async getLastCompletedRaffle(): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status = 'completed'
      ORDER BY id DESC
      LIMIT 1
      `
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async getLastCompletedRaffleByCreator(createdBy: number): Promise<Raffle | null> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status = 'completed'
        AND created_by = $1
      ORDER BY id DESC
      LIMIT 1
      `,
      [createdBy]
    );

    if (result.rowCount === 0) {
      return null;
    }

    return this.mapRaffle(result.rows[0]);
  }

  async getRafflesNeedingHourlyAlert(now: Date): Promise<Raffle[]> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status = 'open'
        AND ends_at IS NOT NULL
        AND announcement_chat_id IS NOT NULL
        AND next_hourly_alert_at IS NOT NULL
        AND next_hourly_alert_at <= $1
      ORDER BY next_hourly_alert_at ASC
      `,
      [now]
    );

    return result.rows.map((row) => this.mapRaffle(row));
  }

  async bumpNextHourlyAlert(raffleId: number, nextAlertAt: Date): Promise<void> {
    await this.pool.query(
      `
      UPDATE raffles
      SET next_hourly_alert_at = $2
      WHERE id = $1
      `,
      [raffleId, nextAlertAt]
    );
  }

  async getRafflesPastEnd(now: Date): Promise<Raffle[]> {
    const result = await this.pool.query(
      `
      SELECT id, title, winner_count, chain, status, created_by, announcement_chat_id, all_entrants_win, ends_at, next_hourly_alert_at, reward_token, reward_total_amount
      FROM raffles
      WHERE status = 'open'
        AND ends_at IS NOT NULL
        AND ends_at <= $1
      ORDER BY ends_at ASC
      `,
      [now]
    );

    return result.rows.map((row) => this.mapRaffle(row));
  }

  async enterRaffle(raffleId: number, input: { userId: number; walletChain: WalletChain; walletAddress: string }): Promise<boolean> {
    const result = await this.pool.query(
      `
      INSERT INTO raffle_entries (raffle_id, user_id, wallet_chain, wallet_address)
      SELECT $1, $2, $3, $4
      WHERE EXISTS (
        SELECT 1
        FROM raffles
        WHERE id = $1
          AND status = 'open'
      )
      ON CONFLICT (raffle_id, user_id) DO NOTHING
      RETURNING id
      `,
      [raffleId, input.userId, input.walletChain, input.walletAddress]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getEntryCount(raffleId: number): Promise<number> {
    const result = await this.pool.query(`SELECT COUNT(*)::int AS count FROM raffle_entries WHERE raffle_id = $1`, [raffleId]);
    return Number(result.rows[0].count);
  }

  async drawWinners(raffleId: number): Promise<WinnerResult[]> {
    const raffleResult = await this.pool.query(`SELECT id, winner_count, all_entrants_win FROM raffles WHERE id = $1`, [raffleId]);
    if (raffleResult.rowCount === 0) {
      throw new Error('Raffle not found');
    }

    const winnerCount = Number(raffleResult.rows[0].winner_count);
    const allEntrantsWin = Boolean(raffleResult.rows[0].all_entrants_win);

    await this.pool.query(`UPDATE raffles SET status = 'drawing' WHERE id = $1`, [raffleId]);

    const entries = allEntrantsWin
      ? await this.pool.query(
          `
          SELECT u.id, u.display_username, e.wallet_chain, e.wallet_address
          FROM raffle_entries e
          INNER JOIN users u ON u.id = e.user_id
          WHERE e.raffle_id = $1
          ORDER BY random()
          `,
          [raffleId]
        )
      : await this.pool.query(
          `
          SELECT u.id, u.display_username, e.wallet_chain, e.wallet_address
          FROM raffle_entries e
          INNER JOIN users u ON u.id = e.user_id
          WHERE e.raffle_id = $1
          ORDER BY random()
          LIMIT $2
          `,
          [raffleId, winnerCount]
        );

    await this.pool.query(`DELETE FROM raffle_winners WHERE raffle_id = $1`, [raffleId]);

    const winners: WinnerResult[] = [];
    let rank = 1;
    for (const row of entries.rows) {
      await this.pool.query(
        `INSERT INTO raffle_winners (raffle_id, user_id, rank) VALUES ($1, $2, $3)`,
        [raffleId, Number(row.id), rank]
      );

      winners.push({
        rank,
        userId: Number(row.id),
        displayUsername: row.display_username,
        walletChain: row.wallet_chain,
        walletAddress: row.wallet_address,
      });
      rank += 1;
    }

    await this.pool.query(`UPDATE raffles SET status = 'completed', completed_at = NOW() WHERE id = $1`, [raffleId]);

    return winners;
  }

  async markWinnerPaid(raffleId: number, rank: number, txHash: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE raffle_winners SET payout_status = 'paid', payout_tx_hash = $3 WHERE raffle_id = $1 AND rank = $2`,
      [raffleId, rank, txHash]
    );

    return (result.rowCount ?? 0) > 0;
  }

  async getWinnersForPayout(raffleId: number): Promise<WinnerResult[]> {
    const result = await this.pool.query(
      `
      SELECT rw.rank, u.id, u.display_username, e.wallet_chain, e.wallet_address
      FROM raffle_winners rw
      INNER JOIN users u ON u.id = rw.user_id
      INNER JOIN raffle_entries e ON e.raffle_id = rw.raffle_id AND e.user_id = rw.user_id
      WHERE rw.raffle_id = $1
      ORDER BY rw.rank ASC
      `,
      [raffleId]
    );

    return result.rows.map((row) => ({
      rank: Number(row.rank),
      userId: Number(row.id),
      displayUsername: row.display_username,
      walletChain: row.wallet_chain,
      walletAddress: row.wallet_address,
    }));
  }

  private mapRaffle(row: any): Raffle {
    return {
      id: Number(row.id),
      title: row.title,
      winnerCount: Number(row.winner_count),
      allEntrantsWin: Boolean(row.all_entrants_win),
      chain: row.chain,
      status: row.status,
      createdBy: Number(row.created_by),
      announcementChatId: row.announcement_chat_id != null ? Number(row.announcement_chat_id) : null,
      endsAt: row.ends_at ? new Date(row.ends_at) : null,
      nextHourlyAlertAt: row.next_hourly_alert_at ? new Date(row.next_hourly_alert_at) : null,
      rewardToken: row.reward_token ?? null,
      rewardTotalAmount: row.reward_total_amount != null ? Number(row.reward_total_amount) : null,
    };
  }
}
