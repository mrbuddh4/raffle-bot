import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import { parse } from 'csv-parse/sync';
import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { RaffleService } from '../services/RaffleService';
import { UserService } from '../services/UserService';
import { PayoutService } from '../services/PayoutService';
import { AdminPayoutWalletService } from '../services/AdminPayoutWalletService';
import { PayrollGroupService } from '../services/PayrollGroupService';
import { GroupChatService } from '../services/GroupChatService';
import { getAdminIds, getRequiredEnv } from '../utils/env';
import { isValidWalletForChain, normalizeWallet, parseWalletChain, WalletChain } from '../utils/validators';

type PendingState =
  | { type: 'register_username' }
  | { type: 'register_chain'; username: string }
  | { type: 'register_wallet'; username: string; chain: WalletChain }
  | { type: 'edit_username' }
  | { type: 'edit_wallet'; chain: WalletChain }
  | { type: 'create_raffle_title'; chatId: number }
  | { type: 'create_raffle_winners'; chatId: number; title: string }
  | { type: 'create_raffle_chain'; chatId: number; title: string; winnerCount: number; allEntrantsWin: boolean }
  | { type: 'create_raffle_duration'; chatId: number; title: string; winnerCount: number; allEntrantsWin: boolean; chain: WalletChain }
  | { type: 'create_raffle_reward_token'; chatId: number; title: string; winnerCount: number; allEntrantsWin: boolean; chain: WalletChain; durationHours: number }
  | { type: 'create_raffle_reward_amount'; chatId: number; title: string; winnerCount: number; allEntrantsWin: boolean; chain: WalletChain; durationHours: number; rewardToken: string }
  | { type: 'csv_upload' }
  | { type: 'payroll_chain' }
  | { type: 'payroll_mode'; chain: WalletChain }
  | { type: 'payroll_token_address'; chain: WalletChain }
  | { type: 'payroll_csv_upload'; chain: WalletChain; mode: 'native' | 'token'; tokenAddress?: string }
  | { type: 'payroll_confirm' }
  | { type: 'payroll_save_group_name' }
  | { type: 'payroll_group_update_upload'; groupId: number; chain: WalletChain; mode: 'native' | 'token'; tokenAddress?: string }
  | { type: 'set_payout_chain' }
  | { type: 'set_payout_mode'; chain: WalletChain }
  | { type: 'set_payout_secret'; chain: WalletChain; mode: 'native' | 'token' }
  | { type: 'remove_payout_chain' }
  | { type: 'remove_payout_mode'; chain: WalletChain }
  | { type: 'mark_paid_rank' }
  | { type: 'mark_paid_tx'; raffleId: number; rank: number }
  | { type: 'execute_payout_mode'; raffleId: number; chain: WalletChain }
  | { type: 'execute_payout_token_address'; raffleId: number; chain: WalletChain }
  | { type: 'execute_payout_amount'; raffleId: number; chain: WalletChain; mode: 'native' | 'token'; tokenAddress?: string }
  | { type: 'execute_payout_confirm' };

interface PendingExecution {
  raffleId: number;
  chain: WalletChain;
  mode: 'native' | 'token';
  tokenAddress?: string;
  amount: number;
  signerSecret: string;
  signerWalletAddress: string;
  targets: Array<{ rank: number; walletAddress: string }>;
}

interface PendingPayrollExecution {
  chain: WalletChain;
  mode: 'native' | 'token';
  tokenAddress?: string;
  groupName?: string;
  groupId?: number;
  signerSecret: string;
  signerWalletAddress: string;
  targets: Array<{ walletAddress: string; amount: number }>;
}

export class RaffleBot {
  private readonly bot: TelegramBot;
  private readonly userService: UserService;
  private readonly raffleService: RaffleService;
  private readonly payoutService: PayoutService;
  private readonly adminPayoutWalletService: AdminPayoutWalletService;
  private readonly payrollGroupService: PayrollGroupService;
  private readonly groupChatService: GroupChatService;
  private readonly adminIds: Set<number>;
  private botUserId: number | null = null;
  private botUsername: string | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private readonly pendingByUser = new Map<number, PendingState>();
  private readonly pendingExecutionByUser = new Map<number, PendingExecution>();
  private readonly pendingPayrollByUser = new Map<number, PendingPayrollExecution>();
  private readonly enterActionLockByKey = new Map<string, number>();
  private readonly recentSuccessfulEnterByKey = new Map<string, number>();
  private readonly lastEnterGroupByUser = new Map<number, { chatId: number; at: number }>();
  private readonly userCardByUser = new Map<number, { chatId: number; messageId: number }>();
  private readonly adminCardByUser = new Map<number, { chatId: number; messageId: number }>();

  constructor(pool: Pool) {
    this.bot = new TelegramBot(getRequiredEnv('TELEGRAM_BOT_TOKEN'), { polling: true });
    this.userService = new UserService(pool);
    this.raffleService = new RaffleService(pool);
    this.payoutService = new PayoutService();
    this.adminPayoutWalletService = new AdminPayoutWalletService(pool);
    this.payrollGroupService = new PayrollGroupService(pool);
    this.groupChatService = new GroupChatService(pool);
    this.adminIds = getAdminIds();
  }

  async start(): Promise<void> {
    this.registerHandlers();
    const me = await this.bot.getMe();
    this.botUserId = me.id;
    this.botUsername = me.username ? me.username.toLowerCase() : null;
    this.startAnnouncementLoop();

    const userCommands: TelegramBot.BotCommand[] = [
      { command: 'start', description: 'Open raffle menu' },
      { command: 'myid', description: 'Show your Telegram user ID' },
      { command: 'profile', description: 'Edit username or wallets' },
      { command: 'currentraffles', description: 'Show active raffles and links' },
      { command: 'register', description: 'Register username + wallet' },
      { command: 'enter', description: 'Enter open raffles for your chain' },
      { command: 'help', description: 'Show help' },
    ];

    const groupCommands: TelegramBot.BotCommand[] = [
      { command: 'enter', description: 'Enter open raffles (uses saved profile)' },
      { command: 'register', description: 'Register username + wallet in DM' },
    ];

    const adminCommands: TelegramBot.BotCommand[] = [
      ...userCommands,
      { command: 'admin', description: 'Admin control panel' },
      { command: 'myraffles', description: 'Admin: list your raffles' },
      { command: 'setpayout', description: 'Admin: set payout wallet' },
      { command: 'removepayout', description: 'Admin: remove payout wallet' },
    ];

    await this.bot.setMyCommands(userCommands, { scope: { type: 'all_private_chats' } });
    await this.bot.setMyCommands(groupCommands, { scope: { type: 'all_group_chats' } });

    for (const adminId of this.adminIds) {
      await this.bot.setMyCommands(adminCommands, { scope: { type: 'chat', chat_id: adminId } });
      await this.bot.setChatMenuButton({ chat_id: adminId, menu_button: { type: 'commands' } });
    }

    await this.bot.setChatMenuButton({ menu_button: { type: 'commands' } });
  }

  async stop(): Promise<void> {
    if (this.announcementTimer) {
      clearInterval(this.announcementTimer);
      this.announcementTimer = null;
    }

    await this.bot.stopPolling();
  }

  private registerHandlers(): void {
    this.bot.onText(/\/start/, (msg) => void this.handleStart(msg));
    this.bot.onText(/\/myid/, (msg) => void this.handleMyId(msg));
    this.bot.onText(/\/profile/, (msg) => void this.handleProfile(msg));
    this.bot.onText(/\/currentraffles/, (msg) => void this.handleCurrentRaffles(msg));
    this.bot.onText(/\/help/, (msg) => void this.handleHelp(msg));
    this.bot.onText(/\/admin/, (msg) => void this.showAdminPanel(msg));
    this.bot.onText(/\/myraffles/, (msg) => void this.handleMyRaffles(msg));
    this.bot.onText(/\/setpayout/, (msg) => void this.handleSetPayoutWallet(msg));
    this.bot.onText(/\/removepayout/, (msg) => void this.handleRemovePayoutWallet(msg));

    this.bot.on('new_chat_members', (msg) => void this.handleNewChatMembers(msg));
    this.bot.on('callback_query', (query) => void this.handleCallback(query));
    this.bot.on('message', (msg) => void this.handlePendingMessage(msg));
  }

  private async handleNewChatMembers(msg: Message): Promise<void> {
    if (!msg.new_chat_members || msg.new_chat_members.length === 0) {
      return;
    }

    if (!this.botUserId) {
      return;
    }

    const botWasAdded = msg.new_chat_members.some((member) => member.id === this.botUserId);
    if (!botWasAdded) {
      return;
    }

    await this.rememberGroupChat(msg.chat);

    await this.bot.sendMessage(
      msg.chat.id,
      [
        '👋 Thanks for adding me to this group.',
        'Members can use /enter to join open raffles using their saved profile.',
        'For private profile setup (username/wallets), DM me with /start then /register or /profile.',
        'Admins can manage raffles with /admin (recommended in DM).',
      ].join('\n')
    );
  }

  private async handleStart(msg: Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return;
    const startPayload = msg.text?.trim().split(/\s+/, 2)[1]?.toLowerCase();

    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, userId))) {
      return;
    }

    if (startPayload === 'enter') {
      const user = await this.userService.getByTelegramUserId(userId);
      if (user) {
        await this.sendEnterPicker(chatId, userId, msg.message_id, true);
        return;
      }

      await this.renderUserCard(
        chatId,
        userId,
        [
          '📝 *Registration Required*',
          '',
          'To enter raffles, register your profile first.',
          'Tap *Register* below to start.',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📝 Register', callback_data: 'user:register' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        },
        msg.message_id
      );
      return;
    }

    if (startPayload === 'register') {
      await this.beginRegistration(msg);
      return;
    }

    await this.sendHomeCard(chatId, userId, msg.message_id);
  }

  private async handleHelp(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    await this.bot.sendMessage(
      msg.chat.id,
      [
        'Commands:',
        '/start - Open main menu',
        '/myid - Show your Telegram user ID',
        '/profile - Edit username or a single wallet',
        '/currentraffles - Show active raffles and links',
        '/register - Save username + chain + wallet',
        '/enter - Enter active raffle quickly',
        '/admin - Admin raffle controls',
        '/myraffles - Admin: list your raffles',
        '/setpayout - Admin: set payout wallet signer',
        '/removepayout - Admin: remove payout wallet signer',
        '',
        'Tip: run /register for `evm` and again for `solana` to save both wallets.',
        'Winners are selected automatically at random in real time once the raffle entry target is reached.',
        '',
        'Admin onboarding:',
        '1) Run /myid',
        '2) Add that numeric ID to ADMIN_IDS in .env',
        '3) Restart bot',
        '',
        'Admin users can still use /register and /enter like normal participants.',
        '',
        'CSV columns for admin upload:',
        'username,wallet_address,chain(optional),telegram_username(optional)',
      ].join('\n')
    );
  }

  private async handleMyId(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId) {
      await this.bot.sendMessage(msg.chat.id, 'Could not read your Telegram user ID.');
      return;
    }

    const lines = [
      `Your Telegram user ID: *${userId}*`,
      `Admin access: *${this.isAdmin(userId) ? 'ENABLED' : 'NOT ENABLED'}*`,
      '',
      'To enable admin access, add this ID to `ADMIN_IDS` in `.env` and restart the bot.',
    ];

    await this.bot.sendMessage(msg.chat.id, lines.join('\n'), { parse_mode: 'Markdown' });
  }

  private async beginRegistration(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      await this.rememberGroupChat(msg.chat);
      const startLink = this.getBotStartLink('register') ?? this.getRegisterLink();
      const body = 'For privacy, wallet registration is only available in DM. Tap below to open chat.';
      const registerButton = startLink
        ? {
            reply_markup: {
              inline_keyboard: [[{ text: '📝 Register', url: startLink }]],
            },
          }
        : undefined;

      const enterCardVideoPath = this.getEnterCardVideoPath();
      if (enterCardVideoPath) {
        await this.bot.sendVideo(msg.chat.id, fs.createReadStream(enterCardVideoPath), {
          caption: body,
          ...registerButton,
        });
        return;
      }

      await this.bot.sendMessage(msg.chat.id, body, registerButton);
      return;
    }

    const userId = msg.from?.id;
    if (!userId) return;

    this.pendingByUser.set(userId, { type: 'register_username' });
    await this.renderUserCard(
      msg.chat.id,
      userId,
      ['📝 *Registration*', '', 'Step 1/3 — Send your username for raffles (display name).'].join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '🏠 Home', callback_data: 'user:home' }]],
        },
      },
      msg.message_id
    );
  }

  private async handleEnterCommand(msg: Message): Promise<void> {
    const userId = msg.from?.id;
    if (!userId) {
      return;
    }

    if (msg.chat.type !== 'private') {
      await this.rememberGroupChat(msg.chat);
      this.rememberEnterGroup(userId, msg.chat.id);
      await this.sendEnterViaDmPrompt(msg.chat.id);
      return;
    }

    await this.sendEnterPicker(msg.chat.id, userId, msg.message_id, msg.chat.type === 'private');
  }

  private async handleProfile(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId) {
      return;
    }

    await this.sendProfileEditor(msg.chat.id, userId);
  }

  private async handleCurrentRaffles(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    if (openRaffles.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No open raffles right now.');
      return;
    }

    const entryCounts = new Map<number, number>(
      await Promise.all(openRaffles.map(async (raffle) => [raffle.id, await this.raffleService.getEntryCount(raffle.id)] as const))
    );

    const registerLink = this.getRegisterLink();
    const fundingLink = process.env.FUNDING_LINK?.trim();
    const lines = openRaffles.map((raffle) => {
      const timeText = this.formatTimeRemaining(raffle.endsAt);
      const utcEndText = raffle.endsAt ? raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
      const enteredText = ` · entered: *${entryCounts.get(raffle.id) ?? 0}*`;
      const rewardText = raffle.rewardToken && raffle.rewardTotalAmount != null
        ? ` · reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*`
        : '';
      return [
        `• *${raffle.title}*`,
        `${raffle.chain.toUpperCase()} · winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*${enteredText}${rewardText}`,
        utcEndText ? `${timeText ? `${timeText} · ` : ''}ends: *${utcEndText}*` : timeText,
      ].filter(Boolean).join('\n');
    });

    await this.bot.sendMessage(
      msg.chat.id,
      [
        '📌 *Current Open Raffles*',
        '',
        ...lines,
        '',
        registerLink ? `Join/Register: ${registerLink}` : null,
        fundingLink ? `Get Funded: ${fundingLink}` : null,
      ].filter(Boolean).join('\n'),
      { parse_mode: 'Markdown' }
    );
  }

  private async sendProfileEditor(chatId: number, userId: number, preferredMessageId?: number, notice?: string): Promise<void> {
    const user = await this.userService.getByTelegramUserId(userId);
    if (!user) {
      await this.bot.sendMessage(chatId, 'No profile found yet. Use /register first.');
      return;
    }

    await this.renderUserCard(
      chatId,
      userId,
      [
        '👤 *Profile Editor*',
        notice ? `${notice}` : null,
        `Username: *${user.displayUsername}*`,
        `EVM Wallet: ${user.evmWalletAddress ? `\`${user.evmWalletAddress}\`` : '_not set_'}`,
        `Solana Wallet: ${user.solanaWalletAddress ? `\`${user.solanaWalletAddress}\`` : '_not set_'}`,
        '',
        'Choose what you want to edit:',
      ].filter(Boolean).join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✏️ Username', callback_data: 'user:edit_username' }],
            [{ text: '🟣 EVM Wallet', callback_data: 'user:edit_wallet:evm' }],
            [{ text: '🟢 Solana Wallet', callback_data: 'user:edit_wallet:solana' }],
            [{ text: '🏠 Home', callback_data: 'user:home' }],
          ],
        },
      },
      preferredMessageId
    );
  }

  private async enterActiveRaffle(msg: Message, specificRaffleId?: number): Promise<void> {
    const userId = msg.from?.id;
    if (!userId) return;

    const lockKey = `${userId}:${specificRaffleId ?? 'all'}`;
    const now = Date.now();
    const lastActionAt = this.enterActionLockByKey.get(lockKey);
    if (lastActionAt && now - lastActionAt < 8000) {
      return;
    }
    this.enterActionLockByKey.set(lockKey, now);

    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    if (openRaffles.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No open raffle right now.');
      return;
    }

    const user = await this.userService.getByTelegramUserId(userId);
    if (!user) {
      await this.bot.sendMessage(msg.chat.id, 'Please register first with /register.');
      return;
    }
    const actorName = user.displayUsername;

    let eligibleRaffles = openRaffles.filter((raffle) => Boolean(this.getUserWalletForChain(user, raffle.chain)));
    if (eligibleRaffles.length === 0) {
      await this.bot.sendMessage(
        msg.chat.id,
        'There are open raffles, but you do not have a wallet saved for their chain(s). Use /register to add EVM and/or Solana wallets.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    if (specificRaffleId != null) {
      eligibleRaffles = eligibleRaffles.filter((raffle) => raffle.id === specificRaffleId);
      if (eligibleRaffles.length === 0) {
        await this.bot.sendMessage(msg.chat.id, 'That raffle is not open or your saved wallet does not match its chain.');
        return;
      }
    }

    const enteredTitles: string[] = [];
    const alreadyEnteredTitles: string[] = [];
    const justClosedTitles: string[] = [];

    for (const raffle of eligibleRaffles) {
      const walletAddress = this.getUserWalletForChain(user, raffle.chain);
      if (!walletAddress) {
        continue;
      }

      const inserted = await this.raffleService.enterRaffle(raffle.id, {
        userId: user.id,
        walletChain: raffle.chain,
        walletAddress,
      });
      if (inserted) {
        enteredTitles.push(raffle.title);
      } else {
        const latestRaffle = await this.raffleService.getRaffleById(raffle.id);
        if (latestRaffle?.status !== 'open') {
          justClosedTitles.push(raffle.title);
        } else {
          alreadyEnteredTitles.push(raffle.title);
        }
      }

      await this.maybeAutoDrawRaffle(raffle.id);
    }

    if (enteredTitles.length === 0) {
      const recentSuccessAt = this.recentSuccessfulEnterByKey.get(lockKey);
      if (recentSuccessAt && Date.now() - recentSuccessAt < 30000) {
        return;
      }

      await this.bot.sendMessage(
        msg.chat.id,
        specificRaffleId != null
          ? `*${actorName}* is already entered in this raffle.`
          : `*${actorName}* is already entered in all eligible open raffles (*${eligibleRaffles.length}*).`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const summaryLines = specificRaffleId != null
      ? [`✅ *${actorName}* entered raffle: *${enteredTitles[0]}*`]
      : [
          `✅ *${actorName}* entered *${enteredTitles.length}* raffle(s):`,
          ...enteredTitles.map((title) => `- ${title}`),
        ];

    if (alreadyEnteredTitles.length > 0 && specificRaffleId == null) {
      summaryLines.push('', `Already entered in *${alreadyEnteredTitles.length}* raffle(s):`);
      summaryLines.push(...alreadyEnteredTitles.map((title) => `- ${title}`));
    }

    if (justClosedTitles.length > 0) {
      summaryLines.push('', `Just closed before your entry was saved (*${justClosedTitles.length}*):`);
      summaryLines.push(...justClosedTitles.map((title) => `- ${title}`));
    }

    await this.bot.sendMessage(
      msg.chat.id,
      summaryLines.join('\n'),
      { parse_mode: 'Markdown' }
    );

    this.recentSuccessfulEnterByKey.set(lockKey, Date.now());

    if (msg.chat.type === 'private') {
      const groupLines = enteredTitles.map((title) => `✅ *${actorName}* entered raffle: *${title}*`);
      const sourceGroupChatId = this.consumeRecentEnterGroup(user.id);
      if (sourceGroupChatId != null) {
        await this.bot.sendMessage(sourceGroupChatId, groupLines.join('\n'), { parse_mode: 'Markdown' });
      } else {
        const fallbackChatIds = await this.getAlertTargetChatIds(null);
        await Promise.all(fallbackChatIds.map(async (targetChatId) => {
          try {
            await this.bot.sendMessage(targetChatId, groupLines.join('\n'), { parse_mode: 'Markdown' });
          } catch (error: any) {
            await this.maybeDeactivateGroupChatOnSendFailure(targetChatId, error);
          }
        }));
      }
    }
  }

  private async sendEnterPicker(chatId: number, userId: number, preferredMessageId?: number, isPrivate = false): Promise<void> {
    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    if (openRaffles.length === 0) {
      await this.bot.sendMessage(chatId, 'No open raffle right now.');
      return;
    }

    const user = await this.userService.getByTelegramUserId(userId);
    if (!user) {
      await this.bot.sendMessage(chatId, 'Please register first with /register.');
      return;
    }

    const eligibleRaffles = openRaffles.filter((raffle) => Boolean(this.getUserWalletForChain(user, raffle.chain)));
    if (eligibleRaffles.length === 0) {
      await this.bot.sendMessage(
        chatId,
        'There are open raffles, but you do not have a wallet saved for their chain(s). Use /register to add EVM and/or Solana wallets.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const entryCounts = new Map<number, number>(
      await Promise.all(openRaffles.map(async (raffle) => [raffle.id, await this.raffleService.getEntryCount(raffle.id)] as const))
    );

    const raffleLines = eligibleRaffles.map((raffle) => {
      const timeText = this.formatTimeRemaining(raffle.endsAt);
      const utcEndText = raffle.endsAt ? raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
      const enteredText = ` · entered: *${entryCounts.get(raffle.id) ?? 0}*`;
      const rewardText = raffle.rewardToken && raffle.rewardTotalAmount != null
        ? ` · reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*`
        : '';
      return [
        `• *${raffle.title}*`,
        `${raffle.chain.toUpperCase()} · winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*${enteredText}${rewardText}`,
        utcEndText ? `${timeText ? `${timeText} · ` : ''}ends: *${utcEndText}*` : timeText,
      ].filter(Boolean).join('\n');
    });

    const raffleButtons = eligibleRaffles.map((raffle) => ([
      {
        text: `✅ Enter: ${raffle.title}`.slice(0, 64),
        callback_data: `user:enter_raffle:${raffle.id}`,
      },
    ]));

    const keyboard = [
      ...raffleButtons,
      [{ text: '✅ Enter All Eligible', callback_data: 'user:enter_all' }],
      ...(isPrivate ? [[{ text: '🏠 Home', callback_data: 'user:home' }]] : []),
    ];

    const body = [
      '🎟 *Choose Raffle Entry*',
      '',
      ...raffleLines,
      '',
      'Choose one raffle or enter all eligible raffles.',
    ].join('\n');

    if (isPrivate) {
      await this.renderUserCard(
        chatId,
        userId,
        body,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: keyboard,
          },
        },
        preferredMessageId
      );
      return;
    }

    await this.bot.sendMessage(chatId, body, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
  }

  private async showAdminPanel(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId || !this.isAdmin(userId)) {
      await this.bot.sendMessage(msg.chat.id, 'Admin only.');
      return;
    }

    await this.sendAdminPanel(msg.chat.id, userId, msg.message_id);
  }

  private async handleMyRaffles(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId || !this.isAdmin(userId)) {
      await this.bot.sendMessage(msg.chat.id, 'Admin only.');
      return;
    }

    await this.sendMyRaffles(msg.chat.id, userId, msg.message_id);
  }

  private async handleSetPayoutWallet(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId || !this.isAdmin(userId)) {
      await this.bot.sendMessage(msg.chat.id, 'Admin only.');
      return;
    }

    this.pendingByUser.set(userId, { type: 'set_payout_chain' });
    await this.renderAdminCard(
      msg.chat.id,
      userId,
      'Set payout wallet signer. Choose chain:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🟣 EVM', callback_data: 'admin:set_payout_chain:evm' },
              { text: '🟢 Solana', callback_data: 'admin:set_payout_chain:solana' },
            ],
            [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
          ],
        },
      },
      msg.message_id
    );
  }

  private async handleRemovePayoutWallet(msg: Message): Promise<void> {
    if (msg.chat.type !== 'private') {
      return;
    }

    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId || !this.isAdmin(userId)) {
      await this.bot.sendMessage(msg.chat.id, 'Admin only.');
      return;
    }

    await this.sendPayoutWalletSettings(msg.chat.id, userId);
    this.pendingByUser.set(userId, { type: 'remove_payout_chain' });
    await this.renderAdminCard(
      msg.chat.id,
      userId,
      'Remove payout signer. Choose chain:',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🟣 EVM', callback_data: 'admin:remove_payout_chain:evm' },
              { text: '🟢 Solana', callback_data: 'admin:remove_payout_chain:solana' },
            ],
            [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
          ],
        },
      },
      msg.message_id
    );
  }

  private async sendPayoutWalletSettings(chatId: number, adminId: number, preferredMessageId?: number): Promise<void> {
    const wallets = await this.adminPayoutWalletService.listWallets(adminId);
    if (wallets.length === 0) {
      await this.renderAdminCard(
        chatId,
        adminId,
        'No payout wallet signers configured yet. Click *Set Payout Wallet* to add one.',
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        preferredMessageId
      );
      return;
    }

    const lines = wallets.map((wallet) => `${wallet.chain.toUpperCase()} ${wallet.mode.toUpperCase()} → \`${wallet.walletAddress}\``);
    await this.renderAdminCard(
      chatId,
      adminId,
      `🔐 *Your payout wallet signers*\n\n${lines.join('\n')}`,
      this.getAdminBackOptions({ parse_mode: 'Markdown' }),
      preferredMessageId
    );
  }

  private async sendMyRaffles(chatId: number, userId: number, preferredMessageId?: number): Promise<void> {

    const raffles = await this.raffleService.getRafflesByCreator(userId, 10);
    if (raffles.length === 0) {
      await this.renderAdminCard(chatId, userId, 'You have not created any raffles yet.', {
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }]],
        },
      }, preferredMessageId);
      return;
    }

    const lines = raffles.map((raffle) => {
      const rewardText = raffle.rewardToken && raffle.rewardTotalAmount != null
        ? ` · reward: ${raffle.rewardTotalAmount} ${raffle.rewardToken}`
        : '';
      return `#${raffle.id} · *${raffle.title}* · ${raffle.status.toUpperCase()} · ${raffle.chain.toUpperCase()} · winners: ${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}${rewardText}`;
    });

    await this.renderAdminCard(
      chatId,
      userId,
      `🗂 *Your recent raffles*\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }]],
        },
      }
      ,
      preferredMessageId
    );
  }

  private async sendAdminPanel(chatId: number, adminId: number, preferredMessageId?: number): Promise<void> {

    const raffle = await this.raffleService.getActiveRaffleByCreator(adminId);
    const rewardText = raffle && raffle.rewardToken && raffle.rewardTotalAmount != null
      ? ` · Reward: ${raffle.rewardTotalAmount} ${raffle.rewardToken}`
      : '';

    await this.renderAdminCard(
      chatId,
      adminId,
      raffle
        ? `🛠 Admin Panel\nYour active raffle: *${raffle.title}* (${raffle.status}) [${raffle.chain.toUpperCase()}] · winners: ${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}${rewardText}`
        : '🛠 Admin Panel\nYou have no active raffle.',
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🗂 My Raffles', callback_data: 'admin:my_raffles' }],
            [{ text: '⚙️ Set Payout Wallet', callback_data: 'admin:set_payout_wallet' }],
            [{ text: '🗑 Remove Payout Wallet', callback_data: 'admin:remove_payout_wallet' }],
            [{ text: '➕ Create Raffle', callback_data: 'admin:create_raffle' }],
            [{ text: '❌ Cancel Active Raffle', callback_data: 'admin:cancel_raffle' }],
            [{ text: '📦 Payout Wallet List', callback_data: 'admin:payouts' }],
            [{ text: '🚀 Execute On-chain Payout', callback_data: 'admin:execute_payout' }],
            [{ text: '💼 Payroll CSV', callback_data: 'admin:payroll' }],
            [{ text: '🗂 Payroll Groups', callback_data: 'admin:payroll_groups' }],
            [{ text: '✅ Mark Winner Paid', callback_data: 'admin:mark_paid' }],
            [{ text: '📄 Upload CSV', callback_data: 'admin:csv' }],
          ],
        },
      },
      preferredMessageId
    );
  }

  private async handleCallback(query: CallbackQuery): Promise<void> {
    const data = query.data;
    const userId = query.from.id;
    const chatId = query.message?.chat.id;
    if (!data || !chatId) return;

    await this.bot.answerCallbackQuery(query.id);

    const isGroupEnterAction = data === 'user:enter' || data === 'user:enter_all' || data.startsWith('user:enter_raffle:');
    await this.rememberGroupChat(query.message?.chat);
    if (query.message?.chat.type !== 'private' && !this.isAdmin(userId) && !isGroupEnterAction) {
      await this.bot.sendMessage(chatId, 'In groups, bot commands are admin-only.');
      return;
    }

    if (data === 'user:register') {
      this.pendingByUser.set(userId, { type: 'register_username' });
      await this.renderUserCard(
        chatId,
        userId,
        ['📝 *Registration*', '', 'Step 1/3 — Send your username for raffles (display name).'].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🏠 Home', callback_data: 'user:home' }]],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'user:profile') {
      await this.sendProfileEditor(chatId, userId, query.message?.message_id);
      return;
    }

    if (data === 'user:reg_back_username') {
      this.pendingByUser.set(userId, { type: 'register_username' });
      await this.renderUserCard(
        chatId,
        userId,
        ['📝 *Registration*', '', 'Step 1/3 — Send your username for raffles (display name).'].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🏠 Home', callback_data: 'user:home' }]],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'user:reg_back_chain') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type === 'register_wallet') {
        this.pendingByUser.set(userId, { type: 'register_chain', username: pending.username });
        await this.renderUserCard(
          chatId,
          userId,
          ['📝 *Registration*', '', `Username: *${pending.username}*`, 'Step 2/3 — Choose chain:'].join('\n'),
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🟣 EVM', callback_data: 'user:register_chain:evm' },
                  { text: '🟢 Solana', callback_data: 'user:register_chain:solana' },
                ],
                [{ text: '⬅️ Back', callback_data: 'user:reg_back_username' }],
                [{ text: '🏠 Home', callback_data: 'user:home' }],
              ],
            },
          },
          query.message?.message_id
        );
      }
      return;
    }

    if (data === 'user:register_chain:evm' || data === 'user:register_chain:solana') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'register_chain') {
        return;
      }

      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, { type: 'register_wallet', username: pending.username, chain });
      await this.renderUserCard(
        chatId,
        userId,
        [
          '📝 *Registration*',
          '',
          `Username: *${pending.username}*`,
          `Chain: *${chain.toUpperCase()}*`,
          'Step 3/3 — Send wallet address.',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back', callback_data: 'user:reg_back_chain' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'user:home') {
      await this.sendHomeCard(chatId, userId, query.message?.message_id);
      return;
    }

    if (data === 'user:edit_username') {
      this.pendingByUser.set(userId, { type: 'edit_username' });
      await this.renderUserCard(
        chatId,
        userId,
        ['✏️ *Edit Username*', '', 'Send your new display username.'].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back', callback_data: 'user:profile' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'user:edit_wallet:evm' || data === 'user:edit_wallet:solana') {
      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, { type: 'edit_wallet', chain });
      await this.renderUserCard(
        chatId,
        userId,
        [
          `✏️ *Edit ${chain.toUpperCase()} Wallet*`,
          '',
          chain === 'evm' ? 'Send your new EVM wallet address (0x...)' : 'Send your new Solana wallet address',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back', callback_data: 'user:profile' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'user:enter') {
      if (query.message?.chat.type !== 'private') {
        this.rememberEnterGroup(userId, chatId);
        await this.sendEnterViaDmPrompt(chatId);
        return;
      }

      await this.sendEnterPicker(chatId, userId, query.message?.message_id, true);
      return;
    }

    if (data === 'user:enter_all') {
      if (query.message?.chat.type !== 'private') {
        this.rememberEnterGroup(userId, chatId);
        await this.sendEnterViaDmPrompt(chatId);
        return;
      }

      await this.enterActiveRaffle({ ...query.message!, from: query.from } as Message);
      return;
    }

    if (data.startsWith('user:enter_raffle:')) {
      if (query.message?.chat.type !== 'private') {
        this.rememberEnterGroup(userId, chatId);
        await this.sendEnterViaDmPrompt(chatId);
        return;
      }

      const raffleId = Number(data.split(':')[2]);
      if (!Number.isInteger(raffleId)) {
        await this.bot.sendMessage(chatId, 'Invalid raffle selection.');
        return;
      }

      await this.enterActiveRaffle({ ...query.message!, from: query.from } as Message, raffleId);
      return;
    }

    if (data === 'admin:open_panel') {
      if (!this.isAdmin(userId)) {
        await this.bot.sendMessage(chatId, 'Admin only.');
        return;
      }

      await this.sendAdminPanel(chatId, userId, query.message?.message_id);
      return;
    }

    if (!data.startsWith('admin:')) return;

    if (!this.isAdmin(userId)) {
      await this.bot.sendMessage(chatId, 'Admin only.');
      return;
    }

    if (data === 'admin:create_raffle') {
      this.pendingByUser.set(userId, { type: 'create_raffle_title', chatId });
      await this.renderAdminCard(
        chatId,
        userId,
        '➕ *Create Raffle*\n\nStep 1/6 — Send raffle title.',
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:cancel_raffle') {
      const activeRaffle = await this.raffleService.getActiveRaffleByCreator(userId);
      if (!activeRaffle) {
        await this.renderAdminCard(
          chatId,
          userId,
          'No active raffle found to cancel.',
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        return;
      }

      await this.renderAdminCard(
        chatId,
        userId,
        `❌ *Cancel Active Raffle*\n\nTitle: *${activeRaffle.title}*\nChain: *${activeRaffle.chain.toUpperCase()}*\n\nAre you sure you want to cancel this raffle?`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Yes, Cancel', callback_data: 'admin:cancel_raffle_confirm' }],
              [{ text: '↩️ Keep Raffle', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:cancel_raffle_confirm') {
      const cancelled = await this.raffleService.cancelActiveRaffleByCreator(userId);
      if (!cancelled) {
        await this.renderAdminCard(
          chatId,
          userId,
          'No active raffle found to cancel.',
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        return;
      }

      await this.renderAdminCard(
        chatId,
        userId,
        `✅ Cancelled raffle *${cancelled.title}*.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:create_raffle_chain:evm' || data === 'admin:create_raffle_chain:solana') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'create_raffle_chain') {
        return;
      }

      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, {
        type: 'create_raffle_duration',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount: pending.winnerCount,
        allEntrantsWin: pending.allEntrantsWin,
        chain,
      });
      await this.renderAdminCard(
        chatId,
        userId,
        '➕ *Create Raffle*\n\nStep 4/6 — How many hours should this raffle run? Send a positive whole number (example: 24).',
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:create_raffle_winners:all') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'create_raffle_winners') {
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'create_raffle_chain',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount: 1,
        allEntrantsWin: true,
      });
      await this.renderAdminCard(
        chatId,
        userId,
        '➕ *Create Raffle*\n\nStep 3/6 — Choose raffle chain:\nWinners: *All entrants*',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 EVM', callback_data: 'admin:create_raffle_chain:evm' },
                { text: '🟢 Solana', callback_data: 'admin:create_raffle_chain:solana' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:my_raffles') {
      await this.sendMyRaffles(chatId, userId, query.message?.message_id);
      return;
    }

    if (data === 'admin:set_payout_wallet') {
      this.pendingByUser.set(userId, { type: 'set_payout_chain' });
      await this.renderAdminCard(
        chatId,
        userId,
        'Choose chain for payout signer setup:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 EVM', callback_data: 'admin:set_payout_chain:evm' },
                { text: '🟢 Solana', callback_data: 'admin:set_payout_chain:solana' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:remove_payout_wallet') {
      this.pendingByUser.set(userId, { type: 'remove_payout_chain' });
      await this.renderAdminCard(
        chatId,
        userId,
        'Choose chain to remove signer from:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 EVM', callback_data: 'admin:remove_payout_chain:evm' },
                { text: '🟢 Solana', callback_data: 'admin:remove_payout_chain:solana' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:set_payout_chain:evm' || data === 'admin:set_payout_chain:solana') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'set_payout_chain') {
        return;
      }

      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, { type: 'set_payout_mode', chain });
      await this.renderAdminCard(
        chatId,
        userId,
        `Choose payout mode for ${chain.toUpperCase()}:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 Native', callback_data: 'admin:set_payout_mode:native' },
                { text: '🪙 Token', callback_data: 'admin:set_payout_mode:token' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:set_payout_mode:native' || data === 'admin:set_payout_mode:token') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'set_payout_mode') {
        return;
      }

      const mode: 'native' | 'token' = data.endsWith(':native') ? 'native' : 'token';
      this.pendingByUser.set(userId, { type: 'set_payout_secret', chain: pending.chain, mode });
      await this.renderAdminCard(
        chatId,
        userId,
        pending.chain === 'evm'
          ? `Send the private key for ${mode.toUpperCase()} payouts on EVM.`
          : `Send the Solana secret key for ${mode.toUpperCase()} payouts (JSON array or base64).`,
        this.getAdminBackOptions(),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:remove_payout_chain:evm' || data === 'admin:remove_payout_chain:solana') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'remove_payout_chain') {
        return;
      }

      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, { type: 'remove_payout_mode', chain });
      await this.renderAdminCard(
        chatId,
        userId,
        `Choose mode to remove for ${chain.toUpperCase()}:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 Native', callback_data: 'admin:remove_payout_mode:native' },
                { text: '🪙 Token', callback_data: 'admin:remove_payout_mode:token' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:remove_payout_mode:native' || data === 'admin:remove_payout_mode:token') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'remove_payout_mode') {
        return;
      }

      const mode: 'native' | 'token' = data.endsWith(':native') ? 'native' : 'token';
      const removed = await this.adminPayoutWalletService.deleteWallet(userId, pending.chain, mode);
      this.pendingByUser.delete(userId);

      await this.renderAdminCard(
        chatId,
        userId,
        removed
          ? `✅ Removed payout signer for *${pending.chain.toUpperCase()} ${mode.toUpperCase()}*.`
          : `No payout signer found for *${pending.chain.toUpperCase()} ${mode.toUpperCase()}*.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:draw') {
      await this.bot.sendMessage(chatId, 'Manual draw is disabled. Winners are selected automatically at random in real time.');
      return;
    }

    if (data === 'admin:payouts') {
      await this.sendPayoutWallets(chatId, userId);
      return;
    }

    if (data === 'admin:csv') {
      this.pendingByUser.set(userId, { type: 'csv_upload' });
      await this.bot.sendMessage(chatId, 'Upload CSV file now. Headers: username,wallet_address,chain(optional),telegram_username(optional)');
      return;
    }

    if (data === 'admin:execute_payout') {
      const raffle = await this.raffleService.getLastCompletedRaffleByCreator(userId);
      if (!raffle) {
        await this.renderAdminCard(
          chatId,
          userId,
          'No completed raffle found in your account for payout. Draw your raffle first.',
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        return;
      }

      this.pendingByUser.set(userId, { type: 'execute_payout_mode', raffleId: raffle.id, chain: raffle.chain });
      await this.renderAdminCard(
        chatId,
        userId,
        `Choose payout mode for *${raffle.chain.toUpperCase()}*:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 Native', callback_data: 'admin:execute_payout_mode:native' },
                { text: '🪙 Token', callback_data: 'admin:execute_payout_mode:token' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:execute_payout_mode:native' || data === 'admin:execute_payout_mode:token') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'execute_payout_mode') {
        return;
      }

      const mode: 'native' | 'token' = data.endsWith(':native') ? 'native' : 'token';
      if (mode === 'native') {
        this.pendingByUser.set(userId, { type: 'execute_payout_amount', raffleId: pending.raffleId, chain: pending.chain, mode: 'native' });
        await this.renderAdminCard(
          chatId,
          userId,
          `Send native amount per winner for ${pending.chain.toUpperCase()} (example: 0.01).`,
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        return;
      }

      this.pendingByUser.set(userId, { type: 'execute_payout_token_address', raffleId: pending.raffleId, chain: pending.chain });
      await this.renderAdminCard(
        chatId,
        userId,
        pending.chain === 'evm'
          ? 'What token do you want to drop? Send ERC-20 token contract address (0x...).'
          : 'What token do you want to drop? Send SPL token mint address.',
        this.getAdminBackOptions(),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:execute_payout_confirm') {
      const execution = this.pendingExecutionByUser.get(userId);
      if (!execution) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(
          chatId,
          userId,
          'No pending payout found. Please start again from admin panel.',
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        return;
      }

      try {
        await this.renderAdminCard(
          chatId,
          userId,
          `⏳ Sending ${execution.chain.toUpperCase()} ${execution.mode === 'native' ? 'native' : 'token'} payouts to ${execution.targets.length} wallet(s)...`,
          this.getAdminBackOptions(),
          query.message?.message_id
        );
        const results = execution.mode === 'native'
          ? await this.payoutService.payoutNative(execution.chain, execution.amount, execution.targets, execution.signerSecret)
          : await this.payoutService.payoutToken(execution.chain, execution.tokenAddress!, execution.amount, execution.targets, execution.signerSecret);

        for (const result of results) {
          await this.raffleService.markWinnerPaid(execution.raffleId, result.rank, result.txHash);
        }

        this.pendingByUser.delete(userId);
        this.pendingExecutionByUser.delete(userId);
        const lines = results.map((result) => `#${result.rank} \`${result.walletAddress}\`\nTx: \`${result.txHash}\``).join('\n\n');
        await this.renderAdminCard(
          chatId,
          userId,
          `✅ On-chain payout complete.\nMode: *${execution.mode.toUpperCase()}*\nFrom wallet: \`${execution.signerWalletAddress}\`\nAmount each: *${execution.amount}* (${execution.chain.toUpperCase()} ${execution.mode === 'native' ? 'native' : 'token'})\n${execution.tokenAddress ? `Token: \`${execution.tokenAddress}\`\n` : ''}\n${lines}`,
          this.getAdminBackOptions({ parse_mode: 'Markdown' }),
          query.message?.message_id
        );
      } catch (error: any) {
        this.pendingExecutionByUser.delete(userId);
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(
          chatId,
          userId,
          `❌ Payout failed: ${error?.message || 'unknown error'}`,
          this.getAdminBackOptions(),
          query.message?.message_id
        );
      }

      return;
    }

    if (data === 'admin:execute_payout_cancel') {
      this.pendingByUser.delete(userId);
      this.pendingExecutionByUser.delete(userId);
      await this.renderAdminCard(chatId, userId, 'Payout cancelled.', this.getAdminBackOptions(), query.message?.message_id);
      return;
    }

    if (data === 'admin:payroll') {
      this.pendingPayrollByUser.delete(userId);
      this.pendingByUser.delete(userId);
      await this.renderAdminCard(
        chatId,
        userId,
        '💼 *Payroll*\n\nChoose payroll action:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '📤 Run CSV Payroll', callback_data: 'admin:payroll_run' }],
              [{ text: '🗂 Payroll Groups', callback_data: 'admin:payroll_groups' }],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_run') {
      this.pendingPayrollByUser.delete(userId);
      this.pendingByUser.set(userId, { type: 'payroll_chain' });
      await this.renderAdminCard(
        chatId,
        userId,
        '💼 *Payroll CSV*\n\nChoose payout chain:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 EVM', callback_data: 'admin:payroll_chain:evm' },
                { text: '🟢 Solana', callback_data: 'admin:payroll_chain:solana' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_groups') {
      await this.sendPayrollGroups(chatId, userId, query.message?.message_id);
      return;
    }

    if (data.startsWith('admin:payroll_group_select:')) {
      const groupId = Number(data.split(':')[2]);
      if (!Number.isInteger(groupId)) {
        await this.renderAdminCard(chatId, userId, 'Invalid payroll group selection.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      await this.sendPayrollGroupDetails(chatId, userId, groupId, query.message?.message_id);
      return;
    }

    if (data.startsWith('admin:payroll_group_execute:')) {
      const groupId = Number(data.split(':')[2]);
      if (!Number.isInteger(groupId)) {
        await this.renderAdminCard(chatId, userId, 'Invalid payroll group selection.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const group = await this.payrollGroupService.getGroupById(userId, groupId);
      if (!group) {
        await this.renderAdminCard(chatId, userId, 'Payroll group not found.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const items = await this.payrollGroupService.getGroupItems(groupId);
      if (items.length === 0) {
        await this.renderAdminCard(chatId, userId, 'Payroll group has no members.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const signer = await this.adminPayoutWalletService.getWallet(userId, group.chain, group.mode);
      if (!signer) {
        await this.renderAdminCard(
          chatId,
          userId,
          `No payout signer configured for *${group.chain.toUpperCase()} ${group.mode.toUpperCase()}*.`,
          this.getAdminBackOptions({ parse_mode: 'Markdown' }),
          query.message?.message_id
        );
        return;
      }

      const targets = items.map((item) => ({ walletAddress: item.walletAddress, amount: item.amount }));
      const totalAmount = targets.reduce((sum, target) => sum + target.amount, 0);

      this.pendingPayrollByUser.set(userId, {
        chain: group.chain,
        mode: group.mode,
        tokenAddress: group.tokenAddress ?? undefined,
        groupName: group.name,
        groupId: group.id,
        signerSecret: signer.secret,
        signerWalletAddress: signer.walletAddress,
        targets,
      });
      this.pendingByUser.set(userId, { type: 'payroll_confirm' });

      const previewLines = targets.slice(0, 8).map((target) => `• ${target.amount} → \`${target.walletAddress}\``);
      await this.renderAdminCard(
        chatId,
        userId,
        [
          `🧾 *Payroll Group Preview*`,
          `Group: *${group.name}*`,
          `Chain: *${group.chain.toUpperCase()}*`,
          `Mode: *${group.mode.toUpperCase()}*`,
          group.tokenAddress ? `Token: \`${group.tokenAddress}\`` : null,
          `Rows: *${targets.length}*`,
          `Total amount: *${totalAmount}*`,
          '',
          '*Sample rows:*',
          ...previewLines,
          targets.length > previewLines.length ? `...and *${targets.length - previewLines.length}* more` : null,
          '',
          'Confirm payroll execution?',
        ].filter(Boolean).join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Confirm Payroll', callback_data: 'admin:payroll_confirm' }],
              [{ text: '❌ Cancel', callback_data: 'admin:payroll_cancel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data.startsWith('admin:payroll_group_update:')) {
      const groupId = Number(data.split(':')[2]);
      if (!Number.isInteger(groupId)) {
        await this.renderAdminCard(chatId, userId, 'Invalid payroll group selection.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const group = await this.payrollGroupService.getGroupById(userId, groupId);
      if (!group) {
        await this.renderAdminCard(chatId, userId, 'Payroll group not found.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'payroll_group_update_upload',
        groupId: group.id,
        chain: group.chain,
        mode: group.mode,
        tokenAddress: group.tokenAddress ?? undefined,
      });
      await this.renderAdminCard(
        chatId,
        userId,
        `🔄 *Update Payroll Group*\n\nGroup: *${group.name}*\nUpload replacement CSV now.\nRequired headers: *wallet_address,amount*`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data.startsWith('admin:payroll_group_delete:')) {
      const groupId = Number(data.split(':')[2]);
      if (!Number.isInteger(groupId)) {
        await this.renderAdminCard(chatId, userId, 'Invalid payroll group selection.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const removed = await this.payrollGroupService.deleteGroup(userId, groupId);
      await this.renderAdminCard(
        chatId,
        userId,
        removed ? '🗑 Payroll group deleted.' : 'Payroll group not found.',
        {
          reply_markup: {
            inline_keyboard: [[{ text: '⬅️ Back to Payroll Groups', callback_data: 'admin:payroll_groups' }]],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_save_group') {
      const execution = this.pendingPayrollByUser.get(userId);
      if (!execution) {
        await this.renderAdminCard(chatId, userId, 'No payroll preview to save. Start payroll first.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      this.pendingByUser.set(userId, { type: 'payroll_save_group_name' });
      await this.renderAdminCard(
        chatId,
        userId,
        'Send a name for this payroll group (example: RAID team, KOL team).',
        this.getAdminBackOptions(),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_chain:evm' || data === 'admin:payroll_chain:solana') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'payroll_chain') {
        return;
      }

      const chain: WalletChain = data.endsWith(':evm') ? 'evm' : 'solana';
      this.pendingByUser.set(userId, { type: 'payroll_mode', chain });
      await this.renderAdminCard(
        chatId,
        userId,
        `💼 *Payroll CSV*\n\nChain: *${chain.toUpperCase()}*\nChoose payout mode:`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '💰 Native', callback_data: 'admin:payroll_mode:native' },
                { text: '🪙 Token', callback_data: 'admin:payroll_mode:token' },
              ],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        },
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_mode:native' || data === 'admin:payroll_mode:token') {
      const pending = this.pendingByUser.get(userId);
      if (pending?.type !== 'payroll_mode') {
        return;
      }

      const mode: 'native' | 'token' = data.endsWith(':native') ? 'native' : 'token';
      if (mode === 'token') {
        this.pendingByUser.set(userId, { type: 'payroll_token_address', chain: pending.chain });
        await this.renderAdminCard(
          chatId,
          userId,
          pending.chain === 'evm'
            ? '💼 *Payroll CSV*\n\nSend ERC-20 token contract address (0x...) for payroll.'
            : '💼 *Payroll CSV*\n\nSend SPL token mint address for payroll.',
          this.getAdminBackOptions({ parse_mode: 'Markdown' }),
          query.message?.message_id
        );
        return;
      }

      this.pendingByUser.set(userId, { type: 'payroll_csv_upload', chain: pending.chain, mode: 'native' });
      await this.renderAdminCard(
        chatId,
        userId,
        `💼 *Payroll CSV*\n\nUpload payroll CSV now.\nRequired headers: *wallet_address,amount*\nChain: *${pending.chain.toUpperCase()}*\nMode: *NATIVE*`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_confirm') {
      const execution = this.pendingPayrollByUser.get(userId);
      if (!execution) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(chatId, userId, 'No pending payroll found. Please start again.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      await this.renderAdminCard(
        chatId,
        userId,
        `⏳ Processing payroll for *${execution.targets.length}* wallet(s)...`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );

      const success: Array<{ walletAddress: string; amount: number; txHash: string }> = [];
      const failures: Array<{ walletAddress: string; amount: number; error: string }> = [];

      for (let index = 0; index < execution.targets.length; index += 1) {
        const target = execution.targets[index];
        try {
          const payoutResults = execution.mode === 'native'
            ? await this.payoutService.payoutNative(
                execution.chain,
                target.amount,
                [{ rank: index + 1, walletAddress: target.walletAddress }],
                execution.signerSecret
              )
            : await this.payoutService.payoutToken(
                execution.chain,
                execution.tokenAddress!,
                target.amount,
                [{ rank: index + 1, walletAddress: target.walletAddress }],
                execution.signerSecret
              );

          const txHash = payoutResults[0]?.txHash ?? 'unknown';
          success.push({ walletAddress: target.walletAddress, amount: target.amount, txHash });
        } catch (error: any) {
          failures.push({
            walletAddress: target.walletAddress,
            amount: target.amount,
            error: error?.message || 'unknown error',
          });
        }
      }

      const totalAmount = execution.targets.reduce((sum, target) => sum + target.amount, 0);
      const successAmount = success.reduce((sum, item) => sum + item.amount, 0);

      this.pendingPayrollByUser.delete(userId);
      this.pendingByUser.delete(userId);

      const successLines = success.slice(0, 8).map((item) => `✅ ${item.amount} → \`${item.walletAddress}\`\nTx: \`${item.txHash}\``);
      const failureLines = failures.slice(0, 5).map((item) => `❌ ${item.amount} → \`${item.walletAddress}\`\nReason: ${item.error}`);

      await this.renderAdminCard(
        chatId,
        userId,
        [
          '💼 *Payroll Complete*',
          execution.groupName ? `Group: *${execution.groupName}*` : null,
          `Chain: *${execution.chain.toUpperCase()}*`,
          `Mode: *${execution.mode.toUpperCase()}*`,
          execution.tokenAddress ? `Token: \`${execution.tokenAddress}\`` : null,
          `From wallet: \`${execution.signerWalletAddress}\``,
          `Rows processed: *${execution.targets.length}*`,
          `Successful: *${success.length}* (${successAmount})`,
          `Failed: *${failures.length}*`,
          `CSV total amount: *${totalAmount}*`,
          successLines.length > 0 ? '' : null,
          successLines.length > 0 ? '*Successful sends (sample):*' : null,
          ...successLines,
          failureLines.length > 0 ? '' : null,
          failureLines.length > 0 ? '*Failed sends (sample):*' : null,
          ...failureLines,
        ].filter(Boolean).join('\n'),
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        query.message?.message_id
      );
      return;
    }

    if (data === 'admin:payroll_cancel') {
      this.pendingPayrollByUser.delete(userId);
      this.pendingByUser.delete(userId);
      await this.renderAdminCard(chatId, userId, 'Payroll cancelled.', this.getAdminBackOptions(), query.message?.message_id);
      return;
    }

    if (data === 'admin:mark_paid') {
      const raffleId = await this.raffleService.getLastCompletedRaffleIdByCreator(userId);
      if (!raffleId) {
        await this.renderAdminCard(chatId, userId, 'No completed raffle found in your account.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const winners = await this.raffleService.getWinnersForPayout(raffleId);
      if (winners.length === 0) {
        await this.renderAdminCard(chatId, userId, 'No winners available to mark paid.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      const rankButtons = winners.map((winner) => ([{ text: `#${winner.rank} ${winner.displayUsername}`, callback_data: `admin:mark_paid_rank:${raffleId}:${winner.rank}` }]));
      await this.renderAdminCard(chatId, userId, 'Select winner rank to mark as paid:', {
        reply_markup: {
          inline_keyboard: [...rankButtons, [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }]],
        },
      }, query.message?.message_id);
      return;
    }

    if (data.startsWith('admin:mark_paid_rank:')) {
      const parts = data.split(':');
      const raffleId = Number(parts[2]);
      const rank = Number(parts[3]);
      if (!Number.isInteger(raffleId) || !Number.isInteger(rank)) {
        await this.renderAdminCard(chatId, userId, 'Invalid winner selection.', this.getAdminBackOptions(), query.message?.message_id);
        return;
      }

      this.pendingByUser.set(userId, { type: 'mark_paid_tx', raffleId, rank });
      await this.renderAdminCard(chatId, userId, `Send payout tx hash for winner #${rank}.`, this.getAdminBackOptions(), query.message?.message_id);
      return;
    }
  }

  private async handlePendingMessage(msg: Message): Promise<void> {
    await this.rememberGroupChat(msg.chat);

    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!userId) return;

    const command = this.getMessageCommand(msg);
    if (command === 'register') {
      await this.beginRegistration(msg);
      return;
    }
    if (command === 'enter') {
      await this.handleEnterCommand(msg);
      return;
    }

    const pending = this.pendingByUser.get(userId);
    if (!pending) return;

    const isUserProfileFlow = pending.type === 'edit_username'
      || pending.type === 'edit_wallet'
      || pending.type === 'register_username'
      || pending.type === 'register_chain'
      || pending.type === 'register_wallet';

    if (isUserProfileFlow && msg.chat.type === 'private') {
      await this.safeDeleteMessage(msg.chat.id, msg.message_id);
    }

    if (pending.type === 'csv_upload') {
      if (!this.isAdmin(userId)) return;
      if (!msg.document) {
        await this.bot.sendMessage(msg.chat.id, 'Please upload a CSV file as a document.');
        return;
      }

      await this.handleCsvUpload(msg);
      this.pendingByUser.delete(userId);
      return;
    }

    if (pending.type === 'payroll_csv_upload') {
      if (!this.isAdmin(userId)) return;
      if (!msg.document) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          'Please upload a CSV file as a document. Required headers: *wallet_address,amount*',
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );
        return;
      }

      await this.handlePayrollCsvUpload(msg, pending);
      return;
    }

    if (pending.type === 'payroll_group_update_upload') {
      if (!this.isAdmin(userId)) return;
      if (!msg.document) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          'Please upload a CSV file as a document. Required headers: *wallet_address,amount*',
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );
        return;
      }

      await this.handlePayrollGroupCsvUpdate(msg, pending);
      return;
    }

    if (pending.type === 'set_payout_chain') {
      if (!text) {
        return;
      }

      const chain = parseWalletChain(text);
      if (!chain) {
        await this.bot.sendMessage(msg.chat.id, 'Invalid chain. Send `evm` or `solana`.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      this.pendingByUser.set(userId, { type: 'set_payout_mode', chain });
      await this.bot.sendMessage(
        msg.chat.id,
        `Send payout mode for ${chain.toUpperCase()}: \`native\` or \`token\`.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (pending.type === 'set_payout_mode') {
      if (!text) {
        return;
      }

      const mode = text.toLowerCase();
      if (mode !== 'native' && mode !== 'token') {
        await this.bot.sendMessage(msg.chat.id, 'Invalid mode. Send `native` or `token`.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      this.pendingByUser.set(userId, { type: 'set_payout_secret', chain: pending.chain, mode });
      await this.bot.sendMessage(
        msg.chat.id,
        pending.chain === 'evm'
          ? `Send the private key for ${mode.toUpperCase()} payouts on EVM.`
          : `Send the Solana secret key for ${mode.toUpperCase()} payouts (JSON array or base64).`,
        this.getAdminBackOptions()
      );
      return;
    }

    if (pending.type === 'set_payout_secret') {
      if (!text) {
        return;
      }

      try {
        const walletAddress = this.payoutService.getWalletAddressFromSecret(pending.chain, text);
        await this.adminPayoutWalletService.upsertWallet({
          adminTelegramUserId: userId,
          chain: pending.chain,
          mode: pending.mode,
          secret: text,
          walletAddress: pending.chain === 'evm' ? walletAddress.toLowerCase() : walletAddress,
        });

        this.pendingByUser.delete(userId);
        await this.bot.sendMessage(
          msg.chat.id,
          `✅ Saved payout signer.\nChain: *${pending.chain.toUpperCase()}*\nMode: *${pending.mode.toUpperCase()}*\nWallet: \`${walletAddress}\``,
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );
      } catch {
        await this.bot.sendMessage(msg.chat.id, 'Invalid signer secret for selected chain/mode. Please send it again.', this.getAdminBackOptions());
      }
      return;
    }

    if (pending.type === 'remove_payout_chain') {
      if (!text) {
        return;
      }

      const chain = parseWalletChain(text);
      if (!chain) {
        await this.bot.sendMessage(msg.chat.id, 'Invalid chain. Send `evm` or `solana`.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      this.pendingByUser.set(userId, { type: 'remove_payout_mode', chain });
      await this.bot.sendMessage(
        msg.chat.id,
        `Send mode to remove for ${chain.toUpperCase()}: \`native\` or \`token\`.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (pending.type === 'remove_payout_mode') {
      if (!text) {
        return;
      }

      const mode = text.toLowerCase();
      if (mode !== 'native' && mode !== 'token') {
        await this.bot.sendMessage(msg.chat.id, 'Invalid mode. Send `native` or `token`.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      const removed = await this.adminPayoutWalletService.deleteWallet(userId, pending.chain, mode);
      this.pendingByUser.delete(userId);

      await this.bot.sendMessage(
        msg.chat.id,
        removed
          ? `✅ Removed payout signer for *${pending.chain.toUpperCase()} ${mode.toUpperCase()}*.`
          : `No payout signer found for *${pending.chain.toUpperCase()} ${mode.toUpperCase()}*.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (!text) {
      return;
    }

    if (pending.type === 'payroll_token_address') {
      const valid = isValidWalletForChain(text, pending.chain);
      if (!valid) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          pending.chain === 'evm' ? 'Invalid ERC-20 token address.' : 'Invalid SPL token mint address.',
          this.getAdminBackOptions()
        );
        return;
      }

      const tokenAddress = normalizeWallet(text);
      this.pendingByUser.set(userId, {
        type: 'payroll_csv_upload',
        chain: pending.chain,
        mode: 'token',
        tokenAddress,
      });
      await this.renderAdminCard(
        msg.chat.id,
        userId,
        `💼 *Payroll CSV*\n\nUpload payroll CSV now.\nRequired headers: *wallet_address,amount*\nChain: *${pending.chain.toUpperCase()}*\nMode: *TOKEN*\nToken: \`${tokenAddress}\``,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (pending.type === 'payroll_save_group_name') {
      const execution = this.pendingPayrollByUser.get(userId);
      const groupName = text.trim();
      if (!execution) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, 'No payroll preview to save.', this.getAdminBackOptions());
        return;
      }

      if (!groupName) {
        await this.renderAdminCard(msg.chat.id, userId, 'Group name cannot be empty. Send a valid name.', this.getAdminBackOptions());
        return;
      }

      const savedGroup = await this.payrollGroupService.upsertGroupWithItems({
        adminTelegramUserId: userId,
        name: groupName,
        chain: execution.chain,
        mode: execution.mode,
        tokenAddress: execution.tokenAddress,
        items: execution.targets,
      });

      execution.groupName = savedGroup.name;
      execution.groupId = savedGroup.id;
      this.pendingPayrollByUser.set(userId, execution);
      this.pendingByUser.set(userId, { type: 'payroll_confirm' });

      await this.renderAdminCard(
        msg.chat.id,
        userId,
        `✅ Saved payroll group *${savedGroup.name}* with *${execution.targets.length}* rows.\nYou can now confirm payroll or cancel.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Confirm Payroll', callback_data: 'admin:payroll_confirm' }],
              [{ text: '❌ Cancel', callback_data: 'admin:payroll_cancel' }],
            ],
          },
        }
      );
      return;
    }

    if (pending.type === 'edit_username') {
      const current = await this.userService.getByTelegramUserId(userId);
      if (!current) {
        this.pendingByUser.delete(userId);
        await this.bot.sendMessage(msg.chat.id, 'No profile found. Use /register first.');
        return;
      }

      const saved = await this.userService.upsertUser({
        telegramUserId: userId,
        telegramUsername: msg.from?.username ?? null,
        displayUsername: text,
        walletChain: current.walletChain,
        walletAddress: current.walletAddress,
      });

      this.pendingByUser.delete(userId);
      await this.sendProfileEditor(msg.chat.id, userId, undefined, `✅ Username updated to *${saved.displayUsername}*.`);
      return;
    }

    if (pending.type === 'edit_wallet') {
      if (!isValidWalletForChain(text, pending.chain)) {
        await this.renderUserCard(
          msg.chat.id,
          userId,
          [
            `✏️ *Edit ${pending.chain.toUpperCase()} Wallet*`,
            '',
            `❌ Invalid wallet format for ${pending.chain.toUpperCase()}.`,
            pending.chain === 'evm' ? 'Send your new EVM wallet address (0x...)' : 'Send your new Solana wallet address',
          ].join('\n'),
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Back', callback_data: 'user:profile' }],
                [{ text: '🏠 Home', callback_data: 'user:home' }],
              ],
            },
          }
        );
        return;
      }

      const current = await this.userService.getByTelegramUserId(userId);
      if (!current) {
        this.pendingByUser.delete(userId);
        await this.bot.sendMessage(msg.chat.id, 'No profile found. Use /register first.');
        return;
      }

      const saved = await this.userService.upsertUser({
        telegramUserId: userId,
        telegramUsername: msg.from?.username ?? null,
        displayUsername: current.displayUsername,
        walletChain: pending.chain,
        walletAddress: normalizeWallet(text),
      });

      this.pendingByUser.delete(userId);
      await this.sendProfileEditor(msg.chat.id, userId, undefined, `✅ ${pending.chain.toUpperCase()} wallet updated.`);
      return;
    }

    if (pending.type === 'register_username') {
      this.pendingByUser.set(userId, { type: 'register_chain', username: text });
      await this.renderUserCard(
        msg.chat.id,
        userId,
        ['📝 *Registration*', '', `Username: *${text}*`, 'Step 2/3 — Choose chain:'].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [
                { text: '🟣 EVM', callback_data: 'user:register_chain:evm' },
                { text: '🟢 Solana', callback_data: 'user:register_chain:solana' },
              ],
              [{ text: '⬅️ Back', callback_data: 'user:reg_back_username' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        }
      );
      return;
    }

    if (pending.type === 'register_chain') {
      const chain = parseWalletChain(text);
      if (!chain) {
        await this.renderUserCard(
          msg.chat.id,
          userId,
          ['📝 *Registration*', '', `Username: *${pending.username}*`, '❌ Invalid chain. Choose one below:'].join('\n'),
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [
                  { text: '🟣 EVM', callback_data: 'user:register_chain:evm' },
                  { text: '🟢 Solana', callback_data: 'user:register_chain:solana' },
                ],
                [{ text: '⬅️ Back', callback_data: 'user:reg_back_username' }],
                [{ text: '🏠 Home', callback_data: 'user:home' }],
              ],
            },
          }
        );
        return;
      }

      this.pendingByUser.set(userId, { type: 'register_wallet', username: pending.username, chain });
      await this.renderUserCard(
        msg.chat.id,
        userId,
        [
          '📝 *Registration*',
          '',
          `Username: *${pending.username}*`,
          `Chain: *${chain.toUpperCase()}*`,
          'Step 3/3 — Send wallet address.',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '⬅️ Back', callback_data: 'user:reg_back_chain' }],
              [{ text: '🏠 Home', callback_data: 'user:home' }],
            ],
          },
        }
      );
      return;
    }

    if (pending.type === 'register_wallet') {
      if (!isValidWalletForChain(text, pending.chain)) {
        await this.renderUserCard(
          msg.chat.id,
          userId,
          [
            '📝 *Registration*',
            '',
            `Username: *${pending.username}*`,
            `Chain: *${pending.chain.toUpperCase()}*`,
            `❌ Invalid wallet format for ${pending.chain.toUpperCase()}. Send wallet address again.`,
          ].join('\n'),
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⬅️ Back', callback_data: 'user:reg_back_chain' }],
                [{ text: '🏠 Home', callback_data: 'user:home' }],
              ],
            },
          }
        );
        return;
      }

      const saved = await this.userService.upsertUser({
        telegramUserId: userId,
        telegramUsername: msg.from?.username ?? null,
        displayUsername: pending.username,
        walletChain: pending.chain,
        walletAddress: normalizeWallet(text),
      });

      this.pendingByUser.delete(userId);
      await this.sendProfileEditor(msg.chat.id, userId, undefined, '✅ Profile saved.');
      return;
    }

    if (pending.type === 'create_raffle_title') {
      this.pendingByUser.set(userId, { type: 'create_raffle_winners', chatId: pending.chatId, title: text });
      await this.renderAdminCard(
        msg.chat.id,
        userId,
        '➕ *Create Raffle*\n\nStep 2/6 — How many winners? Send a number (example: 10) or choose *All Entrants*.',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '♾ All Entrants', callback_data: 'admin:create_raffle_winners:all' }],
              [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
            ],
          },
        }
      );
      return;
    }

    if (pending.type === 'create_raffle_winners') {
      const allEntrantsWin = text.trim().toLowerCase() === 'all';
      const winnerCount = allEntrantsWin ? 1 : Number(text);
      if (!allEntrantsWin && (!Number.isInteger(winnerCount) || winnerCount <= 0)) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          'Winner count must be a positive whole number, or send *all*.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '♾ All Entrants', callback_data: 'admin:create_raffle_winners:all' }],
                [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
              ],
            },
          }
        );
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'create_raffle_chain',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount,
        allEntrantsWin,
      });
      await this.renderAdminCard(msg.chat.id, userId, `➕ *Create Raffle*\n\nStep 3/6 — Choose raffle chain:\nWinners: *${allEntrantsWin ? 'All entrants' : winnerCount}*`, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🟣 EVM', callback_data: 'admin:create_raffle_chain:evm' },
              { text: '🟢 Solana', callback_data: 'admin:create_raffle_chain:solana' },
            ],
            [{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }],
          ],
        },
      });
      return;
    }

    if (pending.type === 'create_raffle_chain') {
      const chain = parseWalletChain(text);
      if (!chain) {
        await this.renderAdminCard(msg.chat.id, userId, 'Invalid chain. Choose one of the buttons above.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'create_raffle_duration',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount: pending.winnerCount,
        allEntrantsWin: pending.allEntrantsWin,
        chain,
      });
      await this.renderAdminCard(msg.chat.id, userId, '➕ *Create Raffle*\n\nStep 4/6 — How many hours should this raffle run? Send a positive whole number (example: 24).', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
      return;
    }

    if (pending.type === 'create_raffle_duration') {
      const durationHours = Number(text);
      if (!Number.isInteger(durationHours) || durationHours <= 0) {
        await this.renderAdminCard(msg.chat.id, userId, 'Duration must be a positive whole number of hours.', this.getAdminBackOptions());
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'create_raffle_reward_token',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount: pending.winnerCount,
        allEntrantsWin: pending.allEntrantsWin,
        chain: pending.chain,
        durationHours,
      });
      await this.renderAdminCard(
        msg.chat.id,
        userId,
        '➕ *Create Raffle*\n\nStep 5/6 — What token will be dropped to winners? Send token name/symbol (example: USDC).',
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (pending.type === 'create_raffle_reward_token') {
      const rewardToken = text.trim();
      if (!rewardToken) {
        await this.renderAdminCard(msg.chat.id, userId, 'Reward token cannot be empty.', this.getAdminBackOptions());
        return;
      }

      this.pendingByUser.set(userId, {
        type: 'create_raffle_reward_amount',
        chatId: pending.chatId,
        title: pending.title,
        winnerCount: pending.winnerCount,
        allEntrantsWin: pending.allEntrantsWin,
        chain: pending.chain,
        durationHours: pending.durationHours,
        rewardToken,
      });
      await this.renderAdminCard(
        msg.chat.id,
        userId,
        `➕ *Create Raffle*\n\nStep 6/6 — How much *${rewardToken}* total will be distributed? Send a positive number (example: 1000).`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    if (pending.type === 'create_raffle_reward_amount') {
      const rewardTotalAmount = Number(text);
      if (!Number.isFinite(rewardTotalAmount) || rewardTotalAmount <= 0) {
        await this.renderAdminCard(msg.chat.id, userId, 'Reward total amount must be a positive number.', this.getAdminBackOptions());
        return;
      }

      try {
        const raffle = await this.raffleService.createRaffle(
          pending.title,
          pending.winnerCount,
          pending.allEntrantsWin,
          pending.chain,
          userId,
          pending.chatId,
          pending.durationHours,
          pending.rewardToken,
          rewardTotalAmount
        );
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `🎉 Raffle created!\nTitle: *${raffle.title}*\nWinners: *${pending.allEntrantsWin ? 'All entrants' : raffle.winnerCount}*\nChain: *${raffle.chain.toUpperCase()}*\nDuration: *${pending.durationHours} hour(s)*\nReward: *${rewardTotalAmount} ${pending.rewardToken}*\nUsers can now press *Enter*.\nWinner selection is automatic and random when the raffle time window ends.`,
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );

        await this.announceRaffleGoLive(raffle);
      } catch (error: any) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `Could not create raffle yet: ${error?.message || 'unknown error'}. Please send amount again.`,
          this.getAdminBackOptions()
        );
      }
      return;
    }

    if (pending.type === 'mark_paid_rank') {
      const rank = Number(text);
      if (!Number.isInteger(rank) || rank <= 0) {
        await this.renderAdminCard(msg.chat.id, userId, 'Rank must be a positive number.', this.getAdminBackOptions());
        return;
      }

      const raffleId = await this.raffleService.getLastCompletedRaffleIdByCreator(userId);
      if (!raffleId) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, 'No completed raffle found in your account.', this.getAdminBackOptions());
        return;
      }

      this.pendingByUser.set(userId, { type: 'mark_paid_tx', raffleId, rank });
      await this.renderAdminCard(msg.chat.id, userId, `Send payout tx hash for winner #${rank}.`, this.getAdminBackOptions());
      return;
    }

    if (pending.type === 'mark_paid_tx') {
      const ok = await this.raffleService.markWinnerPaid(pending.raffleId, pending.rank, text);
      this.pendingByUser.delete(userId);
      await this.renderAdminCard(msg.chat.id, userId, ok ? '✅ Winner marked paid.' : 'Could not mark paid.', this.getAdminBackOptions());
      return;
    }

    if (pending.type === 'execute_payout_amount') {
      const enteredAmount = Number(text);
      if (!Number.isFinite(enteredAmount) || enteredAmount <= 0) {
        await this.renderAdminCard(msg.chat.id, userId, 'Amount must be a positive number.', this.getAdminBackOptions());
        return;
      }

      const winners = await this.raffleService.getWinnersForPayout(pending.raffleId);
      if (winners.length === 0) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, 'No winners found for payout.', this.getAdminBackOptions());
        return;
      }

      const signer = await this.adminPayoutWalletService.getWallet(userId, pending.chain, pending.mode);
      if (!signer) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `No payout signer configured for *${pending.chain.toUpperCase()} ${pending.mode.toUpperCase()}*. Use /setpayout first.`,
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );
        return;
      }

      const targets = winners.map((winner) => ({ rank: winner.rank, walletAddress: winner.walletAddress }));

      const totalAmount = pending.mode === 'token' ? enteredAmount : enteredAmount * targets.length;
      const amountPerWinner = pending.mode === 'token' ? enteredAmount / targets.length : enteredAmount;

      if (!Number.isFinite(amountPerWinner) || amountPerWinner <= 0) {
        await this.renderAdminCard(msg.chat.id, userId, 'Total token amount is too small for the current winner count.', this.getAdminBackOptions());
        return;
      }

      this.pendingExecutionByUser.set(userId, {
        raffleId: pending.raffleId,
        chain: pending.chain,
        mode: pending.mode,
        tokenAddress: pending.tokenAddress,
        amount: amountPerWinner,
        signerSecret: signer.secret,
        signerWalletAddress: signer.walletAddress,
        targets,
      });
      this.pendingByUser.set(userId, { type: 'execute_payout_confirm' });

      await this.renderAdminCard(
        msg.chat.id,
        userId,
        [
          '🧾 *Payout Preview*',
          `Chain: *${pending.chain.toUpperCase()}*`,
          `Mode: *${pending.mode.toUpperCase()}*`,
          pending.tokenAddress ? `Token: \`${pending.tokenAddress}\`` : null,
          `From wallet: \`${signer.walletAddress}\``,
          `Winners: *${targets.length}*`,
          `Amount per winner: *${amountPerWinner}*`,
          `Total amount: *${totalAmount}*`,
          '',
          'Choose an action below:',
        ].filter(Boolean).join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Confirm Payout', callback_data: 'admin:execute_payout_confirm' }],
              [{ text: '❌ Cancel', callback_data: 'admin:execute_payout_cancel' }],
            ],
          },
        }
      );

      return;
    }

    if (pending.type === 'execute_payout_confirm') {
      const decision = text.trim().toUpperCase();

      if (decision === 'CANCEL') {
        this.pendingByUser.delete(userId);
        this.pendingExecutionByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, 'Payout cancelled.', this.getAdminBackOptions());
        return;
      }

      if (decision !== 'CONFIRM') {
        await this.renderAdminCard(msg.chat.id, userId, 'Please type *CONFIRM* to execute or *CANCEL* to abort.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      const execution = this.pendingExecutionByUser.get(userId);
      if (!execution) {
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, 'No pending payout found. Please start again from admin panel.', this.getAdminBackOptions());
        return;
      }

      try {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `⏳ Sending ${execution.chain.toUpperCase()} ${execution.mode === 'native' ? 'native' : 'token'} payouts to ${execution.targets.length} wallet(s)...`
          ,
          this.getAdminBackOptions()
        );
        const results = execution.mode === 'native'
          ? await this.payoutService.payoutNative(execution.chain, execution.amount, execution.targets, execution.signerSecret)
          : await this.payoutService.payoutToken(execution.chain, execution.tokenAddress!, execution.amount, execution.targets, execution.signerSecret);

        for (const result of results) {
          await this.raffleService.markWinnerPaid(execution.raffleId, result.rank, result.txHash);
        }

        this.pendingByUser.delete(userId);
        this.pendingExecutionByUser.delete(userId);
        const lines = results.map((result) => `#${result.rank} \`${result.walletAddress}\`\nTx: \`${result.txHash}\``).join('\n\n');
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `✅ On-chain payout complete.\nMode: *${execution.mode.toUpperCase()}*\nFrom wallet: \`${execution.signerWalletAddress}\`\nAmount each: *${execution.amount}* (${execution.chain.toUpperCase()} ${execution.mode === 'native' ? 'native' : 'token'})\n${execution.tokenAddress ? `Token: \`${execution.tokenAddress}\`\n` : ''}\n${lines}`,
          this.getAdminBackOptions({ parse_mode: 'Markdown' })
        );
      } catch (error: any) {
        this.pendingExecutionByUser.delete(userId);
        this.pendingByUser.delete(userId);
        await this.renderAdminCard(msg.chat.id, userId, `❌ Payout failed: ${error?.message || 'unknown error'}`, this.getAdminBackOptions());
      }

      return;
    }

    if (pending.type === 'execute_payout_mode') {
      const mode = text.trim().toLowerCase();
      if (mode !== 'native' && mode !== 'token') {
        await this.renderAdminCard(msg.chat.id, userId, 'Invalid mode. Choose one using the buttons.', this.getAdminBackOptions({ parse_mode: 'Markdown' }));
        return;
      }

      if (mode === 'native') {
        this.pendingByUser.set(userId, { type: 'execute_payout_amount', raffleId: pending.raffleId, chain: pending.chain, mode: 'native' });
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          `Send native amount per winner for ${pending.chain.toUpperCase()} (example: 0.01).`,
          this.getAdminBackOptions()
        );
        return;
      }

      this.pendingByUser.set(userId, { type: 'execute_payout_token_address', raffleId: pending.raffleId, chain: pending.chain });
      await this.renderAdminCard(
        msg.chat.id,
        userId,
        pending.chain === 'evm'
          ? 'Send ERC-20 token contract address (0x...).'
          : 'Send SPL token mint address.',
        this.getAdminBackOptions()
      );
      return;
    }

    if (pending.type === 'execute_payout_token_address') {
      const valid = isValidWalletForChain(text, pending.chain);
      if (!valid) {
        await this.renderAdminCard(
          msg.chat.id,
          userId,
          pending.chain === 'evm'
            ? 'Invalid ERC-20 contract address.'
            : 'Invalid SPL token mint address.',
          this.getAdminBackOptions()
        );
        return;
      }

      const tokenAddress = normalizeWallet(text);
      this.pendingByUser.set(userId, {
        type: 'execute_payout_amount',
        raffleId: pending.raffleId,
        chain: pending.chain,
        mode: 'token',
        tokenAddress,
      });
      await this.renderAdminCard(msg.chat.id, userId, 'How much total token amount should be distributed across all winners? (human units, example: 500).', this.getAdminBackOptions());
      return;
    }
  }

  private async maybeAutoDrawRaffle(raffleId: number, forceAtEnd = false): Promise<void> {
    const raffle = await this.raffleService.getRaffleById(raffleId);
    if (!raffle || raffle.status !== 'open') {
      return;
    }

    if (!forceAtEnd) {
      return;
    }

    const claimed = await this.raffleService.claimOpenRaffleForDrawing(raffle.id);
    if (!claimed) {
      return;
    }

    const winners = await this.raffleService.drawWinners(raffle.id);
    if (winners.length === 0) {
      await this.sendRaffleClosedAnnouncement(raffle, 'No eligible winners this round.');
      return;
    }

    const winnerLines = winners.map((winner) => `${winner.rank}. ${winner.displayUsername}`).join('\n');
    await this.sendRaffleClosedAnnouncement(raffle, winnerLines);
  }

  private startAnnouncementLoop(): void {
    if (this.announcementTimer) {
      clearInterval(this.announcementTimer);
    }

    this.announcementTimer = setInterval(() => {
      void this.processTimedAnnouncements();
    }, 60000);

    void this.processTimedAnnouncements();
  }

  private async processTimedAnnouncements(): Promise<void> {
    const now = new Date();

    const endedRaffles = await this.raffleService.getRafflesPastEnd(now);
    for (const raffle of endedRaffles) {
      await this.maybeAutoDrawRaffle(raffle.id, true);
    }
  }

  private async announceRaffleGoLive(raffle: { title: string; chain: WalletChain; winnerCount: number; allEntrantsWin: boolean; endsAt: Date | null; announcementChatId: number | null; rewardToken: string | null; rewardTotalAmount: number | null }): Promise<void> {
    const registerLink = this.getRegisterLink();
    const fundingLink = process.env.FUNDING_LINK?.trim();
    const artworkUrl = process.env.RAFFLE_ARTWORK_URL?.trim();
    const goLiveVideoPath = this.getEnterCardVideoPath();
    const countdownText = this.formatTimeRemaining(raffle.endsAt, { markdown: true });
    const hoursText = countdownText ? `Ends in ${countdownText}` : null;
    const utcEndText = raffle.endsAt
      ? `Ends at: *${raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}*`
      : null;

    const caption = [
      `🚨 *RAFFLE IS LIVE*`,
      `*${raffle.title}* [${raffle.chain.toUpperCase()}]`,
      `Winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*`,
      raffle.rewardToken && raffle.rewardTotalAmount != null ? `Reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*` : null,
      hoursText,
      utcEndText,
      registerLink ? `Join/Register: ${registerLink}` : null,
      fundingLink ? `Get Funded: ${fundingLink}` : null,
    ].filter(Boolean).join('\n');

    const targetChatIds = await this.getAlertTargetChatIds(raffle.announcementChatId);
    if (targetChatIds.length === 0) {
      return;
    }

    if (goLiveVideoPath) {
      await Promise.all(targetChatIds.map(async (targetChatId) => {
        try {
          await this.bot.sendVideo(targetChatId, fs.createReadStream(goLiveVideoPath), { caption, parse_mode: 'Markdown' });
        } catch (error: any) {
          await this.maybeDeactivateGroupChatOnSendFailure(targetChatId, error);
        }
      }));
      return;
    }

    if (artworkUrl) {
      await Promise.all(targetChatIds.map(async (targetChatId) => {
        try {
          await this.bot.sendPhoto(targetChatId, artworkUrl, { caption, parse_mode: 'Markdown' });
        } catch (error: any) {
          await this.maybeDeactivateGroupChatOnSendFailure(targetChatId, error);
        }
      }));
      return;
    }

    await Promise.all(targetChatIds.map(async (targetChatId) => {
      try {
        await this.bot.sendMessage(targetChatId, caption, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await this.maybeDeactivateGroupChatOnSendFailure(targetChatId, error);
      }
    }));
  }

  private async sendRaffleClosedAnnouncement(
    raffle: { createdBy: number; announcementChatId: number | null; title: string; chain: WalletChain },
    winnerLines: string
  ): Promise<void> {
    const message = `🏁 *${raffle.title}* is closed.\n\n🎉 *WINNER WINNER* 🎉\n${winnerLines}`;

    await this.bot.sendMessage(raffle.createdBy, message, this.getAdminBackOptions({ parse_mode: 'Markdown' }));

    const targetChatIds = await this.getAlertTargetChatIds(raffle.announcementChatId);
    await Promise.all(targetChatIds.map(async (targetChatId) => {
      try {
        await this.bot.sendMessage(targetChatId, message, { parse_mode: 'Markdown' });
      } catch (error: any) {
        await this.maybeDeactivateGroupChatOnSendFailure(targetChatId, error);
      }
    }));
  }

  private getRegisterLink(): string | null {
    const explicit = process.env.REGISTRATION_LINK?.trim();
    if (explicit) {
      return explicit;
    }

    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (botUsername) {
      const handle = botUsername.replace(/^@/, '');
      return `https://t.me/${handle}`;
    }

    return null;
  }

  private getBotStartLink(payload: string): string | null {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
    if (!botUsername) {
      return null;
    }

    return `https://t.me/${botUsername.replace(/^@/, '')}?start=${encodeURIComponent(payload)}`;
  }

  private async sendEnterViaDmPrompt(chatId: number): Promise<void> {
    const botUsername = process.env.TELEGRAM_BOT_USERNAME?.trim();
    const startLink = botUsername
      ? `https://t.me/${botUsername.replace(/^@/, '')}?start=enter`
      : this.getRegisterLink();

    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    const entryCounts = new Map<number, number>(
      await Promise.all(openRaffles.map(async (raffle) => [raffle.id, await this.raffleService.getEntryCount(raffle.id)] as const))
    );
    const raffleBlocks = openRaffles.map((raffle) => {
      const timeLeft = this.formatTimeRemaining(raffle.endsAt);
      return [
        `• ${raffle.title}`,
        '',
        `Winners: ${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}`,
        `Entered: ${entryCounts.get(raffle.id) ?? 0}`,
        timeLeft,
        '',
        `Chain: ${raffle.chain.toUpperCase()}`,
      ].filter(Boolean).join('\n');
    });

    if (startLink) {
      const body = [
        '🎟 RAFFLE LIVE — ENTER HERE🎟',
        '',
        openRaffles.length > 0 ? `Open raffles: ${openRaffles.length}` : 'No open raffles right now.',
        raffleBlocks.length > 0 ? '' : null,
        ...raffleBlocks.flatMap((block, index) => index === raffleBlocks.length - 1 ? [block] : [block, '']),
        '',
        'Test your luck! Tap below to open chat.',
      ].filter(Boolean).join('\n');

      const enterCardVideoPath = this.getEnterCardVideoPath();
      if (enterCardVideoPath) {
        await this.bot.sendVideo(chatId, fs.createReadStream(enterCardVideoPath), {
          caption: body,
          reply_markup: {
            inline_keyboard: [[{ text: '🔥 ENTER HERE', url: startLink }]],
          },
        });
        return;
      }

      const enterArtworkUrl = process.env.ENTER_CARD_ARTWORK_URL?.trim();
      if (enterArtworkUrl) {
        await this.bot.sendPhoto(chatId, enterArtworkUrl, {
          caption: body,
          reply_markup: {
            inline_keyboard: [[{ text: '🔥 ENTER HERE', url: startLink }]],
          },
        });
        return;
      }

      await this.bot.sendMessage(chatId, body, {
        reply_markup: {
          inline_keyboard: [[{ text: '🔥 ENTER HERE', url: startLink }]],
        },
      });
      return;
    }

    await this.bot.sendMessage(chatId, 'To enter raffles, please DM me first.');
  }

  private getEnterCardVideoPath(): string | null {
    const configuredPath = process.env.ENTER_CARD_VIDEO_PATH?.trim();
    const candidates = [
      configuredPath,
      'assets/enter-card.MP4',
      'assets/enter-card.mp4',
    ].filter((item): item is string => Boolean(item));

    for (const candidate of candidates) {
      const absolutePath = path.isAbsolute(candidate) ? candidate : path.resolve(process.cwd(), candidate);
      if (fs.existsSync(absolutePath)) {
        return absolutePath;
      }
    }

    return null;
  }

  private formatTimeRemaining(endsAt: Date | null, options?: { markdown?: boolean }): string | null {
    if (!endsAt) {
      return null;
    }

    const diffMs = endsAt.getTime() - Date.now();
    const markdown = options?.markdown === true;

    if (diffMs <= 0) {
      return markdown ? '~*0m* left' : '~0m left';
    }

    if (diffMs < 3600000) {
      const minutesLeft = Math.max(1, Math.ceil(diffMs / 60000));
      return markdown ? `~*${minutesLeft}m* left` : `~${minutesLeft}m left`;
    }

    const hoursLeft = Math.max(1, Math.ceil(diffMs / 3600000));
    return markdown ? `~*${hoursLeft}h* left` : `~${hoursLeft}h left`;
  }

  private rememberEnterGroup(userId: number, chatId: number): void {
    this.lastEnterGroupByUser.set(userId, { chatId, at: Date.now() });
  }

  private consumeRecentEnterGroup(userId: number): number | null {
    const value = this.lastEnterGroupByUser.get(userId);
    this.lastEnterGroupByUser.delete(userId);
    if (!value) {
      return null;
    }

    const fifteenMinutesMs = 15 * 60 * 1000;
    if (Date.now() - value.at > fifteenMinutesMs) {
      return null;
    }

    return value.chatId;
  }

  private async sendPayoutWallets(chatId: number, adminId: number, raffleId?: number): Promise<void> {
    const resolvedRaffleId = raffleId ?? (await this.raffleService.getLastCompletedRaffleIdByCreator(adminId));
    if (!resolvedRaffleId) {
      await this.renderAdminCard(chatId, adminId, 'No completed raffle found yet in your account.', this.getAdminBackOptions());
      return;
    }

    const winners = await this.raffleService.getWinnersForPayout(resolvedRaffleId);
    if (winners.length === 0) {
      await this.renderAdminCard(chatId, adminId, 'No winners available for payout.', this.getAdminBackOptions());
      return;
    }

    const lines = winners.map((winner) => `${winner.rank},${winner.displayUsername},${winner.walletChain},${winner.walletAddress}`);
    const csv = ['rank,username,chain,wallet_address', ...lines].join('\n');

    await this.renderAdminCard(
      chatId,
      adminId,
      `💸 *Payout Wallets*\n\n${winners.map((w) => `${w.rank}. ${w.walletChain.toUpperCase()} \`${w.walletAddress}\``).join('\n')}`,
      this.getAdminBackOptions({ parse_mode: 'Markdown' })
    );

    await this.bot.sendDocument(chatId, Buffer.from(csv, 'utf8'), {
      caption: 'CSV payout file',
    }, {
      filename: `payout-raffle-${resolvedRaffleId}.csv`,
      contentType: 'text/csv',
    });
  }

  private async handleCsvUpload(msg: Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const fileId = msg.document?.file_id;
    if (!fileId) {
      await this.bot.sendMessage(chatId, 'Missing CSV document.');
      return;
    }

    if (!userId || !this.isAdmin(userId)) {
      await this.bot.sendMessage(chatId, 'Admin only.');
      return;
    }

    const activeRaffle = await this.raffleService.getActiveRaffleByCreator(userId);
    if (!activeRaffle || activeRaffle.status !== 'open') {
      await this.bot.sendMessage(chatId, 'Create your open raffle first, then upload CSV.');
      return;
    }

    const fileUrl = await this.bot.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      throw new Error(`Failed to download CSV: ${response.status}`);
    }

    const csvRaw = await response.text();
    const records = parse(csvRaw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<Record<string, string>>;

    let inserted = 0;

    for (const row of records) {
      const username = row.username || row.display_username || row.name;
      const wallet = row.wallet_address || row.wallet || row.address;
      const chainValue = row.chain || row.wallet_chain || activeRaffle.chain;
      const chain = parseWalletChain(chainValue) || activeRaffle.chain;

      if (!username || !wallet || !isValidWalletForChain(wallet, chain)) {
        continue;
      }

      if (chain !== activeRaffle.chain) {
        continue;
      }

      const user = await this.userService.upsertUser({
        telegramUserId: Date.now() + inserted + Math.floor(Math.random() * 1000000),
        telegramUsername: row.telegram_username || null,
        displayUsername: username,
        walletChain: chain,
        walletAddress: normalizeWallet(wallet),
      });

      const didEnter = await this.raffleService.enterRaffle(activeRaffle.id, {
        userId: user.id,
        walletChain: chain,
        walletAddress: normalizeWallet(wallet),
      });
      if (didEnter) {
        inserted += 1;
      }
    }

    await this.maybeAutoDrawRaffle(activeRaffle.id);

    const total = await this.raffleService.getEntryCount(activeRaffle.id);
    await this.bot.sendMessage(
      chatId,
      `✅ CSV processed. Added *${inserted}* entries to *${activeRaffle.title}*.\nTotal entries: *${total}*`,
      this.getAdminBackOptions({ parse_mode: 'Markdown' })
    );
  }

  private async handlePayrollCsvUpload(
    msg: Message,
    pending: Extract<PendingState, { type: 'payroll_csv_upload' }>
  ): Promise<void> {
    const chatId = msg.chat.id;
    const adminId = msg.from?.id;
    const fileId = msg.document?.file_id;

    if (!adminId || !fileId || !this.isAdmin(adminId)) {
      await this.bot.sendMessage(chatId, 'Admin only.');
      return;
    }

    const signer = await this.adminPayoutWalletService.getWallet(adminId, pending.chain, pending.mode);
    if (!signer) {
      await this.renderAdminCard(
        chatId,
        adminId,
        `No payout signer configured for *${pending.chain.toUpperCase()} ${pending.mode.toUpperCase()}*. Use *Set Payout Wallet* first.`,
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    const fileUrl = await this.bot.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await this.renderAdminCard(chatId, adminId, `Failed to download CSV: ${response.status}`, this.getAdminBackOptions());
      return;
    }

    const csvRaw = await response.text();
    const rows = parse(csvRaw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<Record<string, string>>;

    const targets: Array<{ walletAddress: string; amount: number }> = [];
    let invalidRows = 0;

    for (const row of rows) {
      const walletRaw = row.wallet_address || row.wallet || row.address;
      const amountRaw = row.amount || row.value;
      const amount = Number(amountRaw);

      if (!walletRaw || !Number.isFinite(amount) || amount <= 0 || !isValidWalletForChain(walletRaw, pending.chain)) {
        invalidRows += 1;
        continue;
      }

      targets.push({ walletAddress: normalizeWallet(walletRaw), amount });
    }

    if (targets.length === 0) {
      await this.renderAdminCard(
        chatId,
        adminId,
        'No valid payroll rows found. Required headers: *wallet_address,amount*',
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    const totalAmount = targets.reduce((sum, target) => sum + target.amount, 0);
    this.pendingPayrollByUser.set(adminId, {
      chain: pending.chain,
      mode: pending.mode,
      tokenAddress: pending.tokenAddress,
      signerSecret: signer.secret,
      signerWalletAddress: signer.walletAddress,
      targets,
    });
    this.pendingByUser.set(adminId, { type: 'payroll_confirm' });

    const previewLines = targets.slice(0, 8).map((target) => `• ${target.amount} → \`${target.walletAddress}\``);
    await this.renderAdminCard(
      chatId,
      adminId,
      [
        '🧾 *Payroll Preview*',
        `Chain: *${pending.chain.toUpperCase()}*`,
        `Mode: *${pending.mode.toUpperCase()}*`,
        pending.tokenAddress ? `Token: \`${pending.tokenAddress}\`` : null,
        `From wallet: \`${signer.walletAddress}\``,
        `Valid rows: *${targets.length}*`,
        `Skipped rows: *${invalidRows}*`,
        `Total amount: *${totalAmount}*`,
        '',
        '*Sample rows:*',
        ...previewLines,
        targets.length > previewLines.length ? `...and *${targets.length - previewLines.length}* more` : null,
        '',
        'Confirm payroll execution?',
      ].filter(Boolean).join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Confirm Payroll', callback_data: 'admin:payroll_confirm' }],
            [{ text: '💾 Save as Group', callback_data: 'admin:payroll_save_group' }],
            [{ text: '❌ Cancel', callback_data: 'admin:payroll_cancel' }],
          ],
        },
      }
    );
  }

  private async handlePayrollGroupCsvUpdate(
    msg: Message,
    pending: Extract<PendingState, { type: 'payroll_group_update_upload' }>
  ): Promise<void> {
    const chatId = msg.chat.id;
    const adminId = msg.from?.id;
    const fileId = msg.document?.file_id;

    if (!adminId || !fileId || !this.isAdmin(adminId)) {
      await this.bot.sendMessage(chatId, 'Admin only.');
      return;
    }

    const group = await this.payrollGroupService.getGroupById(adminId, pending.groupId);
    if (!group) {
      this.pendingByUser.delete(adminId);
      await this.renderAdminCard(chatId, adminId, 'Payroll group not found.', this.getAdminBackOptions());
      return;
    }

    const fileUrl = await this.bot.getFileLink(fileId);
    const response = await fetch(fileUrl);
    if (!response.ok) {
      await this.renderAdminCard(chatId, adminId, `Failed to download CSV: ${response.status}`, this.getAdminBackOptions());
      return;
    }

    const csvRaw = await response.text();
    const rows = parse(csvRaw, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    }) as Array<Record<string, string>>;

    const items: Array<{ walletAddress: string; amount: number }> = [];
    let invalidRows = 0;

    for (const row of rows) {
      const walletRaw = row.wallet_address || row.wallet || row.address;
      const amountRaw = row.amount || row.value;
      const amount = Number(amountRaw);

      if (!walletRaw || !Number.isFinite(amount) || amount <= 0 || !isValidWalletForChain(walletRaw, pending.chain)) {
        invalidRows += 1;
        continue;
      }

      items.push({ walletAddress: normalizeWallet(walletRaw), amount });
    }

    if (items.length === 0) {
      await this.renderAdminCard(
        chatId,
        adminId,
        'No valid rows found in CSV. Required headers: *wallet_address,amount*',
        this.getAdminBackOptions({ parse_mode: 'Markdown' })
      );
      return;
    }

    await this.payrollGroupService.upsertGroupWithItems({
      adminTelegramUserId: adminId,
      name: group.name,
      chain: group.chain,
      mode: group.mode,
      tokenAddress: group.tokenAddress ?? undefined,
      items,
    });

    this.pendingByUser.delete(adminId);
    await this.renderAdminCard(
      chatId,
      adminId,
      `✅ Updated payroll group *${group.name}*.\nRows imported: *${items.length}*\nSkipped rows: *${invalidRows}*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[{ text: '⬅️ Back to Payroll Groups', callback_data: 'admin:payroll_groups' }]],
        },
      }
    );
  }

  private async sendPayrollGroups(chatId: number, adminId: number, preferredMessageId?: number): Promise<void> {
    const groups = await this.payrollGroupService.listGroups(adminId);
    if (groups.length === 0) {
      await this.renderAdminCard(
        chatId,
        adminId,
        'No payroll groups saved yet. Run *Payroll CSV* and use *Save as Group* after preview.',
        this.getAdminBackOptions({ parse_mode: 'Markdown' }),
        preferredMessageId
      );
      return;
    }

    const lines = groups.map((group) => `${group.id}. *${group.name}* · ${group.chain.toUpperCase()} · ${group.mode.toUpperCase()}`);
    const buttons = groups.slice(0, 20).map((group) => ([{ text: `🗂 ${group.name}`, callback_data: `admin:payroll_group_select:${group.id}` }]));

    await this.renderAdminCard(
      chatId,
      adminId,
      `🗂 *Payroll Groups*\n\n${lines.join('\n')}`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [...buttons, [{ text: '⬅️ Back to Payroll', callback_data: 'admin:payroll' }]],
        },
      },
      preferredMessageId
    );
  }

  private async sendPayrollGroupDetails(chatId: number, adminId: number, groupId: number, preferredMessageId?: number): Promise<void> {
    const group = await this.payrollGroupService.getGroupById(adminId, groupId);
    if (!group) {
      await this.renderAdminCard(chatId, adminId, 'Payroll group not found.', this.getAdminBackOptions(), preferredMessageId);
      return;
    }

    const items = await this.payrollGroupService.getGroupItems(group.id);
    const totalAmount = items.reduce((sum, item) => sum + item.amount, 0);
    const preview = items.slice(0, 6).map((item) => `• ${item.amount} → \`${item.walletAddress}\``);

    await this.renderAdminCard(
      chatId,
      adminId,
      [
        `🗂 *Payroll Group: ${group.name}*`,
        `Chain: *${group.chain.toUpperCase()}*`,
        `Mode: *${group.mode.toUpperCase()}*`,
        group.tokenAddress ? `Token: \`${group.tokenAddress}\`` : null,
        `Rows: *${items.length}*`,
        `Total amount: *${totalAmount}*`,
        '',
        '*Sample rows:*',
        ...preview,
        items.length > preview.length ? `...and *${items.length - preview.length}* more` : null,
      ].filter(Boolean).join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Execute Group', callback_data: `admin:payroll_group_execute:${group.id}` }],
            [{ text: '🔄 Update Group CSV', callback_data: `admin:payroll_group_update:${group.id}` }],
            [{ text: '🗑 Delete Group', callback_data: `admin:payroll_group_delete:${group.id}` }],
            [{ text: '⬅️ Back to Payroll Groups', callback_data: 'admin:payroll_groups' }],
          ],
        },
      },
      preferredMessageId
    );
  }

  private async sendHomeCard(chatId: number, userId: number, preferredMessageId?: number): Promise<void> {
    const user = await this.userService.getByTelegramUserId(userId);
    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    const matchingOpenRaffles = user ? openRaffles.filter((raffle) => Boolean(this.getUserWalletForChain(user, raffle.chain))) : [];

    const lines = [
      '🎉 *Airdrop / Raffle Bot*',
      '',
      openRaffles.length > 0
        ? `Open raffles right now: *${openRaffles.length}*${user ? `\nMatching your chain: *${matchingOpenRaffles.length}*` : ''}`
        : 'No open raffles at the moment.',
      '',
      user
        ? [
            `✅ Registered as *${user.displayUsername}*`,
            `EVM Wallet: ${user.evmWalletAddress ? `\`${user.evmWalletAddress}\`` : '_not set_'}`,
            `Solana Wallet: ${user.solanaWalletAddress ? `\`${user.solanaWalletAddress}\`` : '_not set_'}`,
          ].join('\n')
        : 'You are not registered yet.',
    ];

    await this.renderUserCard(
      chatId,
      userId,
      lines.join('\n'),
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: this.getStartInlineKeyboard(userId, Boolean(user)),
        },
      },
      preferredMessageId
    );
  }

  private async renderUserCard(
    chatId: number,
    userId: number,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
    preferredMessageId?: number
  ): Promise<number> {
    const tracked = this.userCardByUser.get(userId);
    const targetMessageId = preferredMessageId ?? (tracked?.chatId === chatId ? tracked.messageId : undefined);

    if (targetMessageId) {
      try {
        await this.bot.editMessageText(text, {
          ...(options as TelegramBot.EditMessageTextOptions),
          chat_id: chatId,
          message_id: targetMessageId,
        });
        this.userCardByUser.set(userId, { chatId, messageId: targetMessageId });
        return targetMessageId;
      } catch (error: any) {
        const message = typeof error?.message === 'string' ? error.message : '';
        if (message.includes('message is not modified')) {
          this.userCardByUser.set(userId, { chatId, messageId: targetMessageId });
          return targetMessageId;
        }
      }
    }

    const sent = await this.bot.sendMessage(chatId, text, options);
    this.userCardByUser.set(userId, { chatId, messageId: sent.message_id });
    return sent.message_id;
  }

  private async renderAdminCard(
    chatId: number,
    adminId: number,
    text: string,
    options: TelegramBot.SendMessageOptions = {},
    preferredMessageId?: number
  ): Promise<number> {
    const tracked = this.adminCardByUser.get(adminId);
    const targetMessageId = preferredMessageId ?? (tracked?.chatId === chatId ? tracked.messageId : undefined);

    if (targetMessageId) {
      try {
        await this.bot.editMessageText(text, {
          ...(options as TelegramBot.EditMessageTextOptions),
          chat_id: chatId,
          message_id: targetMessageId,
        });
        this.adminCardByUser.set(adminId, { chatId, messageId: targetMessageId });
        return targetMessageId;
      } catch (error: any) {
        const message = typeof error?.message === 'string' ? error.message : '';
        if (message.includes('message is not modified')) {
          this.adminCardByUser.set(adminId, { chatId, messageId: targetMessageId });
          return targetMessageId;
        }
      }
    }

    const sent = await this.bot.sendMessage(chatId, text, options);
    this.adminCardByUser.set(adminId, { chatId, messageId: sent.message_id });
    return sent.message_id;
  }

  private async safeDeleteMessage(chatId: number, messageId?: number): Promise<void> {
    if (!messageId) {
      return;
    }

    try {
      await this.bot.deleteMessage(chatId, messageId);
    } catch {
      // ignore cleanup failures
    }
  }

  private async rememberGroupChat(chat?: Message['chat']): Promise<void> {
    if (!chat || (chat.type !== 'group' && chat.type !== 'supergroup')) {
      return;
    }

    await this.groupChatService.upsertGroupChat(chat.id, chat.type, chat.title ?? null);
  }

  private async getAlertTargetChatIds(primaryChatId: number | null): Promise<number[]> {
    const groupChatIds = await this.groupChatService.listActiveGroupChatIds();
    const merged = new Set<number>(groupChatIds);
    if (primaryChatId != null) {
      merged.add(primaryChatId);
    }
    return [...merged];
  }

  private async maybeDeactivateGroupChatOnSendFailure(chatId: number, error: any): Promise<void> {
    const message = typeof error?.message === 'string' ? error.message.toLowerCase() : '';
    const isRemoved = message.includes('chat not found')
      || message.includes('bot was kicked')
      || message.includes('forbidden')
      || message.includes('have no rights to send');

    if (isRemoved) {
      await this.groupChatService.deactivateGroupChat(chatId);
    }
  }

  private getMessageCommand(msg: Message): string | null {
    const text = msg.text;
    if (!text) {
      return null;
    }

    const commandEntity = msg.entities?.find((entity) => entity.type === 'bot_command' && entity.offset === 0);
    const commandToken = commandEntity
      ? text.slice(0, commandEntity.length)
      : (text.match(/^\/([a-zA-Z0-9_]+(?:@[a-zA-Z0-9_]+)?)/)?.[0] ?? null);
    if (!commandToken) {
      return null;
    }

    if (!commandToken.startsWith('/')) {
      return null;
    }

    const commandBody = commandToken.slice(1);
    const parts = commandBody.split('@');
    const command = parts[0]?.toLowerCase();
    const mentionedBot = parts[1]?.toLowerCase();

    if (!command) {
      return null;
    }

    if (mentionedBot) {
      const configuredBotUsername = process.env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, '').toLowerCase() || null;
      const expectedBotUsername = this.botUsername || configuredBotUsername;
      if (expectedBotUsername && expectedBotUsername !== mentionedBot) {
        return null;
      }
    }

    return command;
  }

  private isAdmin(userId: number): boolean {
    return this.adminIds.has(userId);
  }

  private async ensureGroupAdminAccess(chat: Message['chat'], userId?: number): Promise<boolean> {
    if (chat.type === 'private') {
      return true;
    }

    if (userId && this.isAdmin(userId)) {
      return true;
    }

    await this.bot.sendMessage(chat.id, 'In groups, bot commands are admin-only.');
    return false;
  }

  private getUserWalletForChain(user: { evmWalletAddress: string | null; solanaWalletAddress: string | null }, chain: WalletChain): string | null {
    return chain === 'evm' ? user.evmWalletAddress : user.solanaWalletAddress;
  }

  private getStartInlineKeyboard(userId: number, hasUserProfile: boolean): Array<Array<{ text: string; callback_data: string }>> {
    const keyboard: Array<Array<{ text: string; callback_data: string }>> = [
      [
        { text: hasUserProfile ? '✏️ Update Profile' : '📝 Register', callback_data: hasUserProfile ? 'user:profile' : 'user:register' },
        { text: '✅ Enter', callback_data: 'user:enter' },
      ],
    ];

    if (this.isAdmin(userId)) {
      keyboard.push([{ text: '🛠 Admin Panel', callback_data: 'admin:open_panel' }]);
    }

    return keyboard;
  }

  private getAdminBackOptions(options: TelegramBot.SendMessageOptions = {}): TelegramBot.SendMessageOptions {
    return {
      ...options,
      reply_markup: {
        inline_keyboard: [[{ text: '⬅️ Back to Admin Panel', callback_data: 'admin:open_panel' }]],
      },
    };
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
