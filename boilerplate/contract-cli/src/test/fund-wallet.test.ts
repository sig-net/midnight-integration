// Validates api.fundWalletForFees against the live standalone (no MPC/Sepolia needed):
// the dev chain only endows the genesis seed, so a second wallet must be funded from it
// to pay its own proving fees. This is the funding step e2e STEP 8 relies on for wallet B.
import { unshieldedToken } from '@midnight-ntwrk/ledger-v8';
import * as api from '../api';
import { getConfig, currentDir } from '../config';
import { createLogger } from '../logger-utils';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as Rx from 'rxjs';
import { toHex } from '@midnight-ntwrk/midnight-js-utils';
import { randomBytes } from '../api';
import path from 'path';

const GENESIS = '0000000000000000000000000000000000000000000000000000000000000001';

describe('api.fundWalletForFees — genesis funds a second wallet for proving fees', () => {
  const config = getConfig();
  let A: api.WalletContext;
  let B: api.WalletContext;

  beforeAll(async () => {
    api.setLogger(await createLogger(path.resolve(currentDir, '..', 'logs', 'fund-wallet', 'fund.log')));
    A = await api.buildWalletAndWaitForFunds(config, GENESIS);
    B = await api.buildWallet(config, toHex(randomBytes(32))); // fresh, unendowed, no hang
  }, 1000 * 60 * 5);

  afterAll(async () => {
    await A?.wallet.stop().catch(() => {});
    await B?.wallet.stop().catch(() => {});
  });

  it('transfers NIGHT A→B, registers for dust, and B ends with a positive fee budget', async () => {
    const NIGHT = unshieldedToken().raw;
    const b0: any = await Rx.firstValueFrom(B.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
    expect(b0.unshielded.balances[NIGHT] ?? 0n).toBe(0n); // starts unfunded

    const dust = await api.fundWalletForFees(A, B, 50_000_000_000_000n);
    expect(dust).toBeGreaterThan(0n); // B can now pay for its own proofs

    const b1: any = await Rx.firstValueFrom(B.wallet.state().pipe(Rx.filter((s: any) => s.isSynced)));
    expect(b1.unshielded.balances[NIGHT] ?? 0n).toBeGreaterThanOrEqual(50_000_000_000_000n);
  }, 1000 * 60 * 8);
});
