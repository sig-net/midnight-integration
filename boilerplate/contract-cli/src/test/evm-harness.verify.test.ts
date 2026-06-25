// Standalone check that the EVM harness boots a node, deploys REAL USDC, and can fund
// addresses (USDC mint + ETH). No Midnight standalone needed.
import { ethers } from 'ethers';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startEvmHarness, type EvmHarness } from './evm-harness';

describe('evm-harness: real USDC on a local Hardhat node', () => {
  let h: EvmHarness;
  beforeAll(async () => { h = await startEvmHarness(); }, 1000 * 60 * 3);
  afterAll(async () => { await h?.stop(); });

  it('deploys real USDC (6 decimals, symbol USDC) and mints to an address', async () => {
    expect(await h.usdc.decimals()).toBe(6n);
    expect(await h.usdc.symbol()).toBe('USDC');

    const target = ethers.Wallet.createRandom().address;
    await h.mintUsdc(target, 5_000_000n); // 5 USDC
    expect(await h.usdc.balanceOf(target)).toBe(5_000_000n);

    await h.fundEth(target, ethers.parseEther('1'));
    expect(await h.provider.getBalance(target)).toBe(ethers.parseEther('1'));
  }, 1000 * 60 * 2);
});
