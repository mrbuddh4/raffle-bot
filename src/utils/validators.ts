import { PublicKey } from '@solana/web3.js';

export type WalletChain = 'evm' | 'solana';

export function isValidEvmWallet(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address.trim());
}

export function isValidSolanaWallet(address: string): boolean {
  try {
    const key = new PublicKey(address.trim());
    return PublicKey.isOnCurve(key.toBytes());
  } catch {
    return false;
  }
}

export function isValidWalletForChain(address: string, chain: WalletChain): boolean {
  if (chain === 'evm') {
    return isValidEvmWallet(address);
  }

  return isValidSolanaWallet(address);
}

export function normalizeWallet(address: string): string {
  return address.trim();
}

export function parseWalletChain(value: string): WalletChain | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === 'evm' || normalized === 'ethereum') {
    return 'evm';
  }

  if (normalized === 'solana' || normalized === 'sol') {
    return 'solana';
  }

  return null;
}

export function getChainDisplayName(chain: WalletChain | string): string {
  const normalized = String(chain).toLowerCase();
  if (normalized === 'evm') {
    return 'Paxeer Network';
  }
  if (normalized === 'solana') {
    return 'Solana';
  }
  return chain.toUpperCase();
}
