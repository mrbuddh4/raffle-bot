import { ethers } from 'ethers';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getMint,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { WalletChain } from '../utils/validators';

export interface PayoutTarget {
  rank: number;
  walletAddress: string;
}

export interface PayoutResult {
  rank: number;
  walletAddress: string;
  txHash: string;
}

export class PayoutService {
  private static readonly ERC20_ABI = [
    'function transfer(address to, uint256 value) returns (bool)',
    'function decimals() view returns (uint8)',
  ];

  async payoutNative(chain: WalletChain, amountPerWinner: number, targets: PayoutTarget[], signerSecret?: string): Promise<PayoutResult[]> {
    if (chain === 'evm') {
      return this.payoutEvm(amountPerWinner, targets, signerSecret);
    }

    return this.payoutSolana(amountPerWinner, targets, signerSecret);
  }

  async payoutToken(
    chain: WalletChain,
    tokenAddress: string,
    amountPerWinner: number,
    targets: PayoutTarget[],
    signerSecret?: string
  ): Promise<PayoutResult[]> {
    if (chain === 'evm') {
      return this.payoutEvmToken(tokenAddress, amountPerWinner, targets, signerSecret);
    }

    return this.payoutSolanaToken(tokenAddress, amountPerWinner, targets, signerSecret);
  }

  getWalletAddressFromSecret(chain: WalletChain, secretRaw: string): string {
    if (chain === 'evm') {
      const wallet = new ethers.Wallet(secretRaw.trim());
      return wallet.address;
    }

    const secret = this.parseSecretKey(secretRaw);
    const payer = Keypair.fromSecretKey(secret);
    return payer.publicKey.toBase58();
  }

  private async payoutEvm(amountPerWinner: number, targets: PayoutTarget[], signerSecret?: string): Promise<PayoutResult[]> {
    const rpcUrl = process.env.EVM_RPC_URL || process.env.RPC_ENDPOINT;
    const privateKey = signerSecret || process.env.EVM_PAYOUT_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
      throw new Error('EVM payout env vars missing. Required: EVM_RPC_URL (or RPC_ENDPOINT) and EVM_PAYOUT_PRIVATE_KEY');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const value = ethers.parseEther(amountPerWinner.toString());

    const results: PayoutResult[] = [];

    for (const target of targets) {
      const tx = await wallet.sendTransaction({
        to: target.walletAddress,
        value,
      });
      await tx.wait();
      results.push({
        rank: target.rank,
        walletAddress: target.walletAddress,
        txHash: tx.hash,
      });
    }

    return results;
  }

  private async payoutSolana(amountPerWinner: number, targets: PayoutTarget[], signerSecret?: string): Promise<PayoutResult[]> {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const secretRaw = signerSecret || process.env.SOLANA_PAYOUT_SECRET_KEY;

    if (!rpcUrl || !secretRaw) {
      throw new Error('Solana payout env vars missing. Required: SOLANA_RPC_URL and SOLANA_PAYOUT_SECRET_KEY');
    }

    const secret = this.parseSecretKey(secretRaw);
    const payer = Keypair.fromSecretKey(secret);
    const connection = new Connection(rpcUrl, 'confirmed');
    const lamports = Math.round(amountPerWinner * LAMPORTS_PER_SOL);

    const results: PayoutResult[] = [];

    for (const target of targets) {
      const recipient = new PublicKey(target.walletAddress);
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: recipient,
          lamports,
        })
      );

      const signature = await connection.sendTransaction(tx, [payer]);
      await connection.confirmTransaction(signature, 'confirmed');

      results.push({
        rank: target.rank,
        walletAddress: target.walletAddress,
        txHash: signature,
      });
    }

    return results;
  }

  private async payoutEvmToken(tokenAddress: string, amountPerWinner: number, targets: PayoutTarget[], signerSecret?: string): Promise<PayoutResult[]> {
    const rpcUrl = process.env.EVM_RPC_URL || process.env.RPC_ENDPOINT;
    const privateKey = signerSecret || process.env.EVM_TOKEN_PAYOUT_PRIVATE_KEY || process.env.EVM_PAYOUT_PRIVATE_KEY;

    if (!rpcUrl || !privateKey) {
      throw new Error('EVM token payout env vars missing. Required: EVM_RPC_URL (or RPC_ENDPOINT) and EVM_TOKEN_PAYOUT_PRIVATE_KEY (or EVM_PAYOUT_PRIVATE_KEY)');
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    const token = new ethers.Contract(tokenAddress, PayoutService.ERC20_ABI, wallet);
    const decimals = Number(await token.decimals());
    const amountUnits = ethers.parseUnits(amountPerWinner.toString(), decimals);

    const results: PayoutResult[] = [];

    for (const target of targets) {
      const tx = await token.transfer(target.walletAddress, amountUnits);
      await tx.wait();
      results.push({
        rank: target.rank,
        walletAddress: target.walletAddress,
        txHash: tx.hash,
      });
    }

    return results;
  }

  private async payoutSolanaToken(tokenMintAddress: string, amountPerWinner: number, targets: PayoutTarget[], signerSecret?: string): Promise<PayoutResult[]> {
    const rpcUrl = process.env.SOLANA_RPC_URL;
    const secretRaw = signerSecret || process.env.SOLANA_TOKEN_PAYOUT_SECRET_KEY || process.env.SOLANA_PAYOUT_SECRET_KEY;

    if (!rpcUrl || !secretRaw) {
      throw new Error('Solana token payout env vars missing. Required: SOLANA_RPC_URL and SOLANA_TOKEN_PAYOUT_SECRET_KEY (or SOLANA_PAYOUT_SECRET_KEY)');
    }

    const secret = this.parseSecretKey(secretRaw);
    const payer = Keypair.fromSecretKey(secret);
    const connection = new Connection(rpcUrl, 'confirmed');

    const mintPubkey = new PublicKey(tokenMintAddress);
    const mintInfo = await getMint(connection, mintPubkey);
    const amountUnits = BigInt(Math.round(amountPerWinner * Math.pow(10, mintInfo.decimals)));

    const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);
    const senderInfo = await connection.getAccountInfo(senderTokenAccount);
    if (!senderInfo) {
      throw new Error('Payer does not have an associated token account for the provided mint.');
    }

    const results: PayoutResult[] = [];

    for (const target of targets) {
      const recipient = new PublicKey(target.walletAddress);
      const recipientTokenAccount = await getAssociatedTokenAddress(mintPubkey, recipient);
      const recipientInfo = await connection.getAccountInfo(recipientTokenAccount);

      const tx = new Transaction();

      if (!recipientInfo) {
        tx.add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            recipientTokenAccount,
            recipient,
            mintPubkey,
            TOKEN_PROGRAM_ID
          )
        );
      }

      tx.add(
        createTransferInstruction(
          senderTokenAccount,
          recipientTokenAccount,
          payer.publicKey,
          amountUnits,
          [],
          TOKEN_PROGRAM_ID
        )
      );

      const signature = await connection.sendTransaction(tx, [payer]);
      await connection.confirmTransaction(signature, 'confirmed');

      results.push({
        rank: target.rank,
        walletAddress: target.walletAddress,
        txHash: signature,
      });
    }

    return results;
  }

  /**
   * Accepts Solana secret in JSON array, base58, or base64 format.
   * Throws with a helpful error if parsing fails.
   */
  private parseSecretKey(secretRaw: string): Uint8Array {
    const trimmed = secretRaw.trim();
    // Try JSON array
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as number[];
        if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === 'number')) {
          throw new Error();
        }
        return Uint8Array.from(parsed);
      } catch {
        throw new Error('Invalid JSON array for Solana secret key.');
      }
    }
    // Try base58 (commonly used for Solana private keys)
    try {
      // base58 is typically 44 or 88 chars, but can vary
      const bs58 = require('bs58');
      const decoded = bs58.decode(trimmed);
      if (decoded.length === 64) {
        return decoded;
      }
    } catch {}
    // Try base64
    try {
      const bytes = Buffer.from(trimmed, 'base64');
      if (bytes.length === 64) {
        return Uint8Array.from(bytes);
      }
    } catch {}
    throw new Error('Invalid Solana secret key format. Accepted formats: JSON array, base58, or base64 encoded 64-byte secret.');
  }
}
