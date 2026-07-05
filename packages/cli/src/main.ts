// Runnable CLI entrypoint (`npm run cli`) — a thin commander shell over the
// exported command functions in ./commands. No orchestration logic lives
// here; integration tests import the command functions directly.

import { Command, InvalidArgumentError } from "commander";

import { broadcastEvm } from "./commands/broadcast-evm.ts";
import { claimDeposit } from "./commands/claim-deposit.ts";
import { depositE2E } from "./commands/deposit-e2e.ts";
import { initialize } from "./commands/initialize.ts";
import { pollResponse } from "./commands/poll-response.ts";
import { readState } from "./commands/read-state.ts";
import { refundWithdraw } from "./commands/refund-withdraw.ts";
import { requestDeposit } from "./commands/request-deposit.ts";
import { requestWithdraw } from "./commands/request-withdraw.ts";
import { withdrawE2E } from "./commands/withdraw-e2e.ts";
import { getCliConfig } from "./config.ts";
import { createCliContext, type CliContext } from "./context.ts";

// One context per invocation: config resolved from the environment, connected
// resources (providers, joined vault) lazy inside the context's getters.
const context = (): CliContext => createCliContext(getCliConfig());

const parseBigintArg = (value: string): bigint => {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a non-negative integer");
  }
  return BigInt(value);
};

const parseMsArg = (value: string): number => {
  if (!/^\d+$/.test(value)) {
    throw new InvalidArgumentError("must be a duration in milliseconds");
  }
  return Number(value);
};

const parseRequestIdArg = (value: string): string => {
  const hex = value.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new InvalidArgumentError("must be a 32-byte request id in hex");
  }
  return hex;
};

const program = new Command("erc20-vault-cli").description(
  "Example client of the Midnight ERC20 vault — the reference orchestration a UI would implement. " +
    "Configuration comes from the environment (see packages/cli/README.md).",
);

const withPollingOptions = (command: Command): Command =>
  command
    .option("--interval-ms <ms>", "poll interval", parseMsArg, 5_000)
    .option("--timeout-ms <ms>", "give-up timeout per polling stage", parseMsArg, 300_000);

program
  .command("read-state")
  .description("decode the vault's pending signature requests from the indexer (MPC-convention raw read)")
  .action(async () => {
    await readState(context());
  });

program
  .command("initialize")
  .description("deployer-only one-off: seal the vault's EVM address into the contract config")
  .requiredOption("--vault-evm-address <address>", "the vault's EVM address (20-byte 0x hex)")
  .action(async (options: { vaultEvmAddress: string }) => {
    await initialize(context(), options);
  });

program
  .command("request-deposit")
  .description("record a deposit signature request on the vault's ledger; prints the request id")
  .requiredOption("--amount <amount>", "deposit amount in ERC20 base units", parseBigintArg)
  .requiredOption("--evm-nonce <nonce>", "nonce of the user's derived EVM account", parseBigintArg)
  .action(async (options: { amount: bigint; evmNonce: bigint }) => {
    console.log(await requestDeposit(context(), options));
  });

withPollingOptions(
  program
    .command("poll-response")
    .description("poll the signature-responses contract for a request's MPC response")
    .requiredOption("--request-id <hex>", "the request id to poll for", parseRequestIdArg),
).action(async (options: { requestId: string; intervalMs: number; timeoutMs: number }) => {
  console.log(await pollResponse(context(), options));
});

program
  .command("broadcast-evm")
  .description("broadcast an MPC-signed EVM transaction; prints the transaction hash")
  .requiredOption("--signed-transaction <hex>", "the signed, RLP-encoded EVM transaction (0x hex)")
  .action(async (options: { signedTransaction: string }) => {
    console.log(await broadcastEvm(context(), options));
  });

program
  .command("claim-deposit")
  .description("claim a completed deposit: verify the MPC attestation in-circuit and mint shielded tokens")
  .requiredOption("--request-id <hex>", "the request id to claim", parseRequestIdArg)
  .action(async (options: { requestId: string }) => {
    await claimDeposit(context(), options);
  });

withPollingOptions(
  program
    .command("deposit-e2e")
    .description("full deposit flow: request → poll signed tx → broadcast → poll attestation → claim")
    .requiredOption("--amount <amount>", "deposit amount in ERC20 base units", parseBigintArg)
    .requiredOption("--evm-nonce <nonce>", "nonce of the user's derived EVM account", parseBigintArg),
).action(async (options: { amount: bigint; evmNonce: bigint; intervalMs: number; timeoutMs: number }) => {
  await depositE2E(context(), options);
});

program
  .command("request-withdraw")
  .description("escrow a shielded vault coin and record a withdraw signature request; prints the request id")
  .requiredOption("--amount <amount>", "withdraw amount in ERC20 base units", parseBigintArg)
  .requiredOption("--dest-evm-address <address>", "destination EVM address (20-byte 0x hex)")
  .action(async (options: { amount: bigint; destEvmAddress: string }) => {
    console.log(await requestWithdraw(context(), options));
  });

program
  .command("refund-withdraw")
  .description("settle a withdraw request: success is final, failure re-mints the escrow to the refund recipient")
  .requiredOption("--request-id <hex>", "the request id to settle", parseRequestIdArg)
  .action(async (options: { requestId: string }) => {
    await refundWithdraw(context(), options);
  });

withPollingOptions(
  program
    .command("withdraw-e2e")
    .description("full withdraw flow: request → poll signed tx → broadcast → poll attestation → settle")
    .requiredOption("--amount <amount>", "withdraw amount in ERC20 base units", parseBigintArg)
    .requiredOption("--dest-evm-address <address>", "destination EVM address (20-byte 0x hex)"),
).action(
  async (options: { amount: bigint; destEvmAddress: string; intervalMs: number; timeoutMs: number }) => {
    await withdrawE2E(context(), options);
  },
);

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
}
