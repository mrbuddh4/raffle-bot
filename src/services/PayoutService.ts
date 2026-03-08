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

    try {
      console.log(`[PayoutService] Input length: ${secretRaw.length} chars, first 20: ${secretRaw.slice(0, 20)}`);
      const secret = this.parseSecretKey(secretRaw);
      console.log(`[PayoutService] ✅ Parsed to ${secret.length} bytes, first 8 bytes: ${Array.from(secret.slice(0, 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      
      let payer: Keypair;
      let method = 'unknown';
      
      // Try both methods with detailed error logging
      if (secret.length === 32) {
        try {
          payer = Keypair.fromSeed(secret);
          method = 'fromSeed(32)';
          console.log(`[PayoutService] ✅ Using Keypair.fromSeed(32 bytes)`);
        } catch (seedError: any) {
          console.log(`[PayoutService] ⚠️  fromSeed failed: ${seedError?.message}, trying fromSecretKey...`);
          payer = Keypair.fromSecretKey(secret);
          method = 'fromSecretKey(32)';
        }
      } else if (secret.length === 64) {
        try {
          payer = Keypair.fromSecretKey(secret);
          method = 'fromSecretKey(64)';
          console.log(`[PayoutService] ✅ Using Keypair.fromSecretKey(64 bytes)`);
        } catch (keyError: any) {
          console.log(`[PayoutService] ⚠️  fromSecretKey failed: ${keyError?.message}, trying fromSeed(first 32)...`);
          payer = Keypair.fromSeed(secret.slice(0, 32));
          method = 'fromSeed(first 32 of 64)';
        }
      } else {
        throw new Error(`Unexpected key length: ${secret.length} bytes. Expected 32 or 64.`);
      }
      
      const pubkey = payer.publicKey.toBase58();
      console.log(`[PayoutService] ✅ SUCCESS - Method: ${method}, Derived: ${pubkey}`);
      return pubkey;
    } catch (error: any) {
      const msg = typeof error?.message === 'string' ? error.message : 'Unknown error';
      console.error(`[PayoutService] ❌ FAILED: ${msg}`);
      throw new Error(`Invalid Solana secret key: ${msg}`);
    }
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
    
    let payer: Keypair;
    try {
      payer = secret.length === 32 ? Keypair.fromSeed(secret) : Keypair.fromSecretKey(secret);
    } catch (err1: any) {
      console.log(`[PayoutService] First attempt failed, trying alternate method...`);
      try {
        payer = secret.length === 32 ? Keypair.fromSecretKey(secret) : Keypair.fromSeed(secret.slice(0, 32));
      } catch (err2: any) {
        throw new Error(`Failed both keypair methods: ${err1?.message}, ${err2?.message}`);
      }
    }
    
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
    console.log(`[PayoutService.payoutSolanaToken] Decoded secret: ${secret.length} bytes`);
    
    let payer: Keypair;
    let method = '';
    try {
      if (secret.length === 32) {
        payer = Keypair.fromSeed(secret);
        method = 'fromSeed(32)';
      } else {
        payer = Keypair.fromSecretKey(secret);
        method = 'fromSecretKey(64)';
      }
      console.log(`[PayoutService.payoutSolanaToken] ✅ Keypair derived via ${method}: ${payer.publicKey.toBase58()}`);
    } catch (err1: any) {
      console.log(`[PayoutService.payoutSolanaToken] First attempt (${method}) failed: ${err1?.message}, trying alternate...`);
      try {
        if (secret.length === 32) {
          payer = Keypair.fromSecretKey(secret);
          method = 'fromSecretKey(32)';
        } else {
          payer = Keypair.fromSeed(secret.slice(0, 32));
          method = 'fromSeed(slice(0,32))';
        }
        console.log(`[PayoutService.payoutSolanaToken] ✅ Keypair derived via ${method}: ${payer.publicKey.toBase58()}`);
      } catch (err2: any) {
        throw new Error(`Failed all keypair methods: ${err1?.message}, ${err2?.message}`);
      }
    }
    
    const connection = new Connection(rpcUrl, 'confirmed');

    const mintPubkey = new PublicKey(tokenMintAddress);
    console.log(`[PayoutService.payoutSolanaToken] 🪙 Token mint address: ${tokenMintAddress}`);
    console.log(`[PayoutService.payoutSolanaToken] 🔍 Fetching mint info from Solana...`);
    
    let mintInfo;
    try {
      mintInfo = await getMint(connection, mintPubkey);
      console.log(`[PayoutService.payoutSolanaToken] ✅ Mint info retrieved. Decimals: ${mintInfo.decimals}`);
    } catch (mintErr: any) {
      console.error(`[PayoutService.payoutSolanaToken] ❌ Failed to fetch mint info`);
      console.error(`Error type: ${mintErr?.name}`);
      console.error(`Error code: ${mintErr?.code}`);
      console.error(`Error message: ${mintErr?.message}`);
      console.error(`Full error:`, mintErr);
      throw mintErr;
    }
    
    const amountUnits = BigInt(Math.round(amountPerWinner * Math.pow(10, mintInfo.decimals)));

    const senderTokenAccount = await getAssociatedTokenAddress(mintPubkey, payer.publicKey);
    console.log(`[PayoutService.payoutSolanaToken] 📊 Derived payer token account: ${senderTokenAccount.toBase58()}`);
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

      try {
        console.log(`[PayoutService.payoutSolanaToken] 📤 Sending token transfer to ${target.walletAddress}...`);
        const signature = await connection.sendTransaction(tx, [payer]);
        await connection.confirmTransaction(signature, 'confirmed');

        results.push({
          rank: target.rank,
          walletAddress: target.walletAddress,
          txHash: signature,
        });
        console.log(`[PayoutService.payoutSolanaToken] ✅ Token transfer successful: ${signature}`);
      } catch (txErr: any) {
        console.error(`[PayoutService.payoutSolanaToken] ❌ Token transfer failed for ${target.walletAddress}`);
        console.error(`Error name: ${txErr?.name}`);
        console.error(`Error message: ${txErr?.message}`);
        console.error(`Full error:`, txErr);
        throw txErr;
      }
    }

    return results;
  }

  private base58Decode(str: string): Uint8Array | null {
    // Pure JavaScript Base58 decoder (Solana/Phantom format)
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    
    try {
      // Convert base58 string to bigint
      let num = BigInt(0);
      for (const char of str) {
        const digit = ALPHABET.indexOf(char);
        if (digit === -1) {
          return null; // Invalid character
        }
        num = num * BigInt(58) + BigInt(digit);
      }
      
      // Convert bigint to bytes
      const bytes: number[] = [];
      while (num > 0n) {
        bytes.unshift(Number(num % BigInt(256)));
        num = num / BigInt(256);
      }
      
      // Add leading zero bytes for leading '1's
      for (const char of str) {
        if (char === '1') {
          bytes.unshift(0);
        } else {
          break;
        }
      }
      
      return bytes.length > 0 ? new Uint8Array(bytes) : null;
    } catch (error) {
      return null;
    }
  }

  private parseSecretKey(secretRaw: string): Uint8Array {
    console.log(`[PayoutService.parseSecretKey] ========== START PARSING ==========`);
    console.log(`[PayoutService.parseSecretKey] Raw input length: ${secretRaw.length} characters`);
    console.log(`[PayoutService.parseSecretKey] First 50 chars: ${secretRaw.slice(0, 50)}`);
    console.log(`[PayoutService.parseSecretKey] Last 50 chars: ${secretRaw.slice(-50)}`);
    
    let trimmed = secretRaw.replace(/\s+/g, '').trim();
    console.log(`[PayoutService.parseSecretKey] After stripping whitespace: ${trimmed.length} characters`);
    console.log(`[PayoutService.parseSecretKey] First 50 chars after trim: ${trimmed.slice(0, 50)}`);
    
    if (trimmed.length === 0) {
      throw new Error(`Secret key is empty after stripping whitespace!`);
    }

    // Handle Phantom wallet export: might have extra brackets like [[ ... ]]
    if (trimmed.startsWith('[[')) {
      console.log(`[PayoutService.parseSecretKey] 📋 Detected double brackets [[...]], stripping outer layer`);
      trimmed = trimmed.slice(1, -1); // Remove outer brackets
    }

    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as number[];
        if (!Array.isArray(parsed)) {
          throw new Error('Not a valid array');
        }
        console.log(`[PayoutService.parseSecretKey] 📋 FORMAT: JSON array with ${parsed.length} elements`);
        
        // Accept 32-element or 64-element arrays
        if (parsed.length === 32) {
          console.log(`[PayoutService.parseSecretKey] ✅ Valid 32-element JSON array`);
          return Uint8Array.from(parsed);
        } else if (parsed.length === 64) {
          console.log(`[PayoutService.parseSecretKey] ✅ Valid 64-element JSON array`);
          return Uint8Array.from(parsed);
        } else {
          throw new Error(`Must have 32 or 64 elements, got ${parsed.length}`);
        }
      } catch (error: any) {
        throw new Error(`Invalid JSON array format: ${error?.message || 'JSON parse failed'}`);
      }
    }

    // Try base58 first (Phantom standard export format)
    console.log(`[PayoutService.parseSecretKey] 🔍 Attempting Base58 decode...`);
    const base58Bytes = this.base58Decode(trimmed);
    if (base58Bytes && (base58Bytes.length === 32 || base58Bytes.length === 64)) {
      console.log(`[PayoutService.parseSecretKey] ✅ FORMAT: Successfully decoded as Base58 → ${base58Bytes.length} bytes`);
      return base58Bytes;
    } else if (base58Bytes) {
      console.log(`[PayoutService.parseSecretKey] ⚠️  Base58 gave ${base58Bytes.length} bytes (need 32 or 64), trying base64...`);
    } else {
      console.log(`[PayoutService.parseSecretKey] ⚠️  Base58 decode failed, trying base64...`);
    }

    // Try base64 as fallback
    try {
      const bytes = Buffer.from(trimmed, 'base64');
      console.log(`[PayoutService.parseSecretKey] 📋 FORMAT: Attempting base64 → ${bytes.length} bytes decoded`);
      
      if (bytes.length === 32) {
        console.log(`[PayoutService.parseSecretKey] ✅ Valid 32-byte base64 (seed key)`);
        return bytes;
      } else if (bytes.length === 64) {
        console.log(`[PayoutService.parseSecretKey] ✅ Valid 64-byte base64 (full keypair)`);
        return bytes;
      } else if (bytes.length === 66) {
        console.log(`[PayoutService.parseSecretKey] ⚠️  Got 66 bytes from base64 (possibly Phantom quirk), using first 64`);
        return bytes.slice(0, 64);
      } else {
        throw new Error(`Got ${bytes.length} bytes from base64, trying hex...`);
      }
    } catch (base64Error: any) {
      console.log(`[PayoutService.parseSecretKey] ⚠️  Base64 decode didn't give 32/64/66 bytes, trying hex format...`);
      try {
        // Try hex format
        const bytes = Buffer.from(trimmed, 'hex');
        console.log(`[PayoutService.parseSecretKey] 📋 FORMAT: Attempting hex → ${bytes.length} bytes decoded`);
        
        if (bytes.length === 32) {
          console.log(`[PayoutService.parseSecretKey] ✅ Valid 32-byte hex (seed key)`);
          return bytes;
        } else if (bytes.length === 64) {
          console.log(`[PayoutService.parseSecretKey] ✅ Valid 64-byte hex (full keypair)`);
          return bytes;
        } else {
          throw new Error(`Hex gave ${bytes.length} bytes, need 32 or 64`);
        }
      } catch (hexError: any) {
        const hexMsg = typeof hexError?.message === 'string' ? hexError.message : 'hex decode failed';
        console.error(`[PayoutService.parseSecretKey] ❌ Both base64 and hex failed: ${hexMsg}`);
        throw new Error(`Invalid format (base64 and hex both failed: ${hexMsg})`);
      }
    }
  }
}
