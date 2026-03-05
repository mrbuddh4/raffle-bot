import TelegramBot, { CallbackQuery, Message } from 'node-telegram-bot-api';
import { parse } from 'csv-parse/sync';
import { Pool } from 'pg';
import { RaffleService } from '../services/RaffleService';
import { UserService } from '../services/UserService';
import { PayoutService } from '../services/PayoutService';
import { AdminPayoutWalletService } from '../services/AdminPayoutWalletService';
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

export class RaffleBot {
  private readonly bot: TelegramBot;
  private readonly userService: UserService;
  private readonly raffleService: RaffleService;
  private readonly payoutService: PayoutService;
  private readonly adminPayoutWalletService: AdminPayoutWalletService;
  private readonly adminIds: Set<number>;
  private botUserId: number | null = null;
  private announcementTimer: NodeJS.Timeout | null = null;
  private readonly pendingByUser = new Map<number, PendingState>();
  private readonly pendingExecutionByUser = new Map<number, PendingExecution>();
  private readonly userCardByUser = new Map<number, { chatId: number; messageId: number }>();
  private readonly adminCardByUser = new Map<number, { chatId: number; messageId: number }>();

  constructor(pool: Pool) {
    this.bot = new TelegramBot(getRequiredEnv('TELEGRAM_BOT_TOKEN'), { polling: true });
    this.userService = new UserService(pool);
    this.raffleService = new RaffleService(pool);
    this.payoutService = new PayoutService();
    this.adminPayoutWalletService = new AdminPayoutWalletService(pool);
    this.adminIds = getAdminIds();
  }

  async start(): Promise<void> {
    this.registerHandlers();
    const me = await this.bot.getMe();
    this.botUserId = me.id;
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
      { command: 'start', description: 'Show group raffle help' },
      { command: 'enter', description: 'Enter open raffles (uses saved profile)' },
      { command: 'help', description: 'Show group help' },
    ];

    const adminCommands: TelegramBot.BotCommand[] = [
      ...userCommands,
      { command: 'admin', description: 'Admin control panel' },
      { command: 'myraffles', description: 'Admin: list your raffles' },
      { command: 'setpayout', description: 'Admin: set payout wallet' },
      { command: 'removepayout', description: 'Admin: remove payout wallet' },
    ];

    await this.bot.setMyCommands(userCommands, { scope: { type: 'all_private_chats' } });
    await this.bot.setMyCommands(groupCommands, { scope: { type: 'all_chat_administrators' } });

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
    this.bot.onText(/\/register/, (msg) => void this.beginRegistration(msg));
    this.bot.onText(/\/enter/, (msg) => void this.handleEnterCommand(msg));
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

    if (!(await this.ensureGroupAdminAccess(msg.chat, userId))) {
      return;
    }

    if (msg.chat.type !== 'private') {
      await this.bot.sendMessage(
        chatId,
        [
          '🎉 Raffle Bot is active in this group.',
          'Use /enter to join open raffles.',
          'To set or edit your profile/wallets, DM me with /start then /register or /profile.',
        ].join('\n')
      );
      return;
    }

    await this.sendHomeCard(chatId, userId, msg.message_id);
  }

  private async handleHelp(msg: Message): Promise<void> {
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
    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    if (msg.chat.type !== 'private') {
      await this.bot.sendMessage(
        msg.chat.id,
        'For privacy, wallet registration is only available in DM. Please message me directly with /register.'
      );
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
    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const userId = msg.from?.id;
    if (!userId) {
      return;
    }

    if (msg.chat.type !== 'private') {
      const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
      if (openRaffles.length === 0) {
        await this.bot.sendMessage(msg.chat.id, 'No open raffle right now.');
        return;
      }

      const raffleLines = openRaffles.map((raffle) => {
        const hoursLeft = raffle.endsAt ? Math.max(0, Math.ceil((raffle.endsAt.getTime() - Date.now()) / 3600000)) : null;
        const utcEndText = raffle.endsAt ? raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
        const timeText = hoursLeft != null ? `~${hoursLeft}h left` : null;
        const rewardText = raffle.rewardToken && raffle.rewardTotalAmount != null
          ? ` · reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*`
          : '';
        return [
          `• *${raffle.title}*`,
          `${raffle.chain.toUpperCase()} · winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*${rewardText}`,
          utcEndText ? `${timeText ? `${timeText} · ` : ''}ends: *${utcEndText}*` : timeText,
        ].filter(Boolean).join('\n');
      });

      await this.bot.sendMessage(
        msg.chat.id,
        [
          '🎟 *Ready to Enter Raffle*',
          '',
          ...raffleLines,
          '',
          'Tap *Enter Now* to confirm raffle entry.',
        ].join('\n'),
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '✅ Enter Now', callback_data: 'user:enter' }]],
          },
        }
      );
      return;
    }

    await this.sendHomeCard(msg.chat.id, userId, msg.message_id);
  }

  private async handleProfile(msg: Message): Promise<void> {
    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    if (msg.chat.type !== 'private') {
      await this.bot.sendMessage(
        msg.chat.id,
        'Profile editing is only available in DM. Please message me directly with /profile.'
      );
      return;
    }

    const userId = msg.from?.id;
    if (!userId) {
      return;
    }

    await this.sendProfileEditor(msg.chat.id, userId);
  }

  private async handleCurrentRaffles(msg: Message): Promise<void> {
    if (!(await this.ensureGroupAdminAccess(msg.chat, msg.from?.id))) {
      return;
    }

    const openRaffles = (await this.raffleService.getOpenRaffles()).filter((raffle) => raffle.status === 'open');
    if (openRaffles.length === 0) {
      await this.bot.sendMessage(msg.chat.id, 'No open raffles right now.');
      return;
    }

    const registerLink = this.getRegisterLink();
    const fundingLink = process.env.FUNDING_LINK?.trim();
    const lines = openRaffles.map((raffle) => {
      const hoursLeft = raffle.endsAt ? Math.max(0, Math.ceil((raffle.endsAt.getTime() - Date.now()) / 3600000)) : null;
      const utcEndText = raffle.endsAt ? raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : null;
      const timeText = hoursLeft != null ? `~${hoursLeft}h left` : null;
      const rewardText = raffle.rewardToken && raffle.rewardTotalAmount != null
        ? ` · reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*`
        : '';
      return [
        `• *${raffle.title}*`,
        `${raffle.chain.toUpperCase()} · winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*${rewardText}`,
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

  private async enterActiveRaffle(msg: Message): Promise<void> {
    const userId = msg.from?.id;
    if (!userId) return;

    if (!(await this.ensureGroupAdminAccess(msg.chat, userId))) {
      return;
    }

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

    const eligibleRaffles = openRaffles.filter((raffle) => Boolean(this.getUserWalletForChain(user, raffle.chain)));
    if (eligibleRaffles.length === 0) {
      await this.bot.sendMessage(
        msg.chat.id,
        'There are open raffles, but you do not have a wallet saved for their chain(s). Use /register to add EVM and/or Solana wallets.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const enteredTitles: string[] = [];
    const alreadyEnteredTitles: string[] = [];

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
        alreadyEnteredTitles.push(raffle.title);
      }

      await this.maybeAutoDrawRaffle(raffle.id);
    }

    if (enteredTitles.length === 0) {
      await this.bot.sendMessage(
        msg.chat.id,
        `You are already entered in all eligible open raffles (*${eligibleRaffles.length}*).`,
        { parse_mode: 'Markdown' }
      );
      return;
    }

    const summaryLines = [
      `✅ Entered *${enteredTitles.length}* raffle(s):`,
      ...enteredTitles.map((title) => `- ${title}`),
    ];

    if (alreadyEnteredTitles.length > 0) {
      summaryLines.push('', `Already entered in *${alreadyEnteredTitles.length}* raffle(s):`);
      summaryLines.push(...alreadyEnteredTitles.map((title) => `- ${title}`));
    }

    await this.bot.sendMessage(
      msg.chat.id,
      summaryLines.join('\n'),
      { parse_mode: 'Markdown' }
    );
  }

  private async showAdminPanel(msg: Message): Promise<void> {
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

    if (query.message?.chat.type !== 'private' && !this.isAdmin(userId)) {
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
      await this.enterActiveRaffle({ ...query.message!, from: query.from } as Message);
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
    const userId = msg.from?.id;
    const text = msg.text?.trim();
    if (!userId) return;

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

    const hourlyAlerts = await this.raffleService.getRafflesNeedingHourlyAlert(now);
    for (const raffle of hourlyAlerts) {
      if (!raffle.announcementChatId || !raffle.endsAt) {
        await this.raffleService.bumpNextHourlyAlert(raffle.id, new Date(now.getTime() + 3600000));
        continue;
      }

      const remainingMs = raffle.endsAt.getTime() - now.getTime();
      if (remainingMs > 0) {
        const minutesLeft = Math.max(1, Math.ceil(remainingMs / 60000));
        const countdownText = minutesLeft < 60
          ? `*${minutesLeft}m* left`
          : `*${Math.ceil(minutesLeft / 60)}h* left`;
        const registerLink = this.getRegisterLink();
        await this.bot.sendMessage(
          raffle.announcementChatId,
          [
            `⏰ *${raffle.title}* countdown: ${countdownText}`,
            registerLink ? `Join: ${registerLink}` : null,
          ].filter(Boolean).join('\n'),
          { parse_mode: 'Markdown' }
        );

        const nextDelayMs = minutesLeft <= 60
          ? 60000
          : minutesLeft <= 360
            ? 900000
            : 3600000;
        await this.raffleService.bumpNextHourlyAlert(raffle.id, new Date(now.getTime() + nextDelayMs));
        continue;
      }

      await this.raffleService.bumpNextHourlyAlert(raffle.id, new Date(now.getTime() + 3600000));
    }

    const endedRaffles = await this.raffleService.getRafflesPastEnd(now);
    for (const raffle of endedRaffles) {
      await this.maybeAutoDrawRaffle(raffle.id, true);
    }
  }

  private async announceRaffleGoLive(raffle: { title: string; chain: WalletChain; winnerCount: number; allEntrantsWin: boolean; endsAt: Date | null; announcementChatId: number | null; rewardToken: string | null; rewardTotalAmount: number | null }): Promise<void> {
    const chatId = raffle.announcementChatId;
    if (!chatId) {
      return;
    }

    const registerLink = this.getRegisterLink();
    const fundingLink = process.env.FUNDING_LINK?.trim();
    const artworkUrl = process.env.RAFFLE_ARTWORK_URL?.trim();
    const hoursText = raffle.endsAt
      ? `Ends in ~*${Math.max(1, Math.ceil((raffle.endsAt.getTime() - Date.now()) / 3600000))}h*`
      : null;
    const utcEndText = raffle.endsAt
      ? `Ends at: *${raffle.endsAt.toISOString().replace('T', ' ').replace('.000Z', ' UTC')}*`
      : null;

    const caption = [
      `🚨 *RAFFLE GO LIVE*`,
      `*${raffle.title}* [${raffle.chain.toUpperCase()}]`,
      `Winners: *${raffle.allEntrantsWin ? 'all entrants' : raffle.winnerCount}*`,
      raffle.rewardToken && raffle.rewardTotalAmount != null ? `Reward: *${raffle.rewardTotalAmount} ${raffle.rewardToken}*` : null,
      hoursText,
      utcEndText,
      registerLink ? `Join/Register: ${registerLink}` : null,
      fundingLink ? `Get Funded: ${fundingLink}` : null,
    ].filter(Boolean).join('\n');

    if (artworkUrl) {
      await this.bot.sendPhoto(chatId, artworkUrl, { caption, parse_mode: 'Markdown' });
      return;
    }

    await this.bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
  }

  private async sendRaffleClosedAnnouncement(
    raffle: { createdBy: number; announcementChatId: number | null; title: string; chain: WalletChain },
    winnerLines: string
  ): Promise<void> {
    const message = `🏁 *${raffle.title}* is closed.\n\n🎉 *WINNER WINNER* 🎉\n${winnerLines}`;

    await this.bot.sendMessage(raffle.createdBy, message, this.getAdminBackOptions({ parse_mode: 'Markdown' }));

    if (raffle.announcementChatId) {
      await this.bot.sendMessage(raffle.announcementChatId, message, { parse_mode: 'Markdown' });
    }
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
