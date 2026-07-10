// Runnable CLI entrypoint (`npm run cli`) — a thin commander shell over the
// exported command functions in ./commands. Flow: define the commands, parse
// (help/validation stay offline), then build the wallet + context ONCE and
// run the selected command. No orchestration logic lives here; integration
// tests import the command functions directly.

import { Command, InvalidArgumentError } from "commander";
import { Transaction } from "ethers";

import { deriveAccountKeys, withSyncedWalletFacade } from "@midnight-erc20-vault/lib";
import { parseRequestIdHex, type RequestIdHex } from "@midnight-erc20-vault/signet-midnight";

import { broadcastEvm } from "./commands/broadcast-evm.ts";
import { claimDeposit } from "./commands/claim-deposit.ts";
import { depositE2E } from "./commands/deposit-e2e.ts";
import { initialize } from "./commands/initialize.ts";
import { formatRespondBidirectional, pollRespondBidirectional } from "./commands/poll-respond-bidirectional.ts";
import { pollSignatureResponse } from "./commands/poll-signature-response.ts";
import { readState } from "./commands/read-state.ts";
import { refundWithdraw } from "./commands/refund-withdraw.ts";
import { requestDeposit } from "./commands/request-deposit.ts";
import { requestWithdraw } from "./commands/request-withdraw.ts";
import { withdrawE2E } from "./commands/withdraw-e2e.ts";
import { getCliConfig, requireConfigValue } from "./config.ts";
import { createCliContext, type CliContext } from "./context.ts";

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

const parseRequestIdArg = (value: string): RequestIdHex => {
  try {
    return parseRequestIdHex(value);
  } catch {
    throw new InvalidArgumentError("must be a 32-byte request id in hex");
  }
};

// Edge: parse the serialized-hex CLI arg into a typed transaction here so the
// command works with a Transaction, not a string.
const parseSignedTransactionArg = (value: string): Transaction => {
  try {
    return Transaction.from(value);
  } catch {
    throw new InvalidArgumentError("must be a signed, RLP-encoded EVM transaction (0x hex)");
  }
};

const program = new Command("erc20-vault-cli").description(
  "Example client of the Midnight ERC20 vault — the reference orchestration a UI would implement. " +
    "Configuration comes from the environment (see packages/cli/README.md).",
);

const withPollingOptions = (command: Command): Command =>
  command
    .option("--interval-ms <ms>", "poll interval", parseMsArg, 5_000)
    .option("--timeout-ms <ms>", "give-up timeout per polling stage", parseMsArg, 300_000);

// Each action only records the selected command; the work runs after parsing,
// once the context exists (see the bottom of this file).
let work: ((context: CliContext) => Promise<void>) | undefined;

program
  .command("read-state")
  .description("read the vault's public ledger: config, and pending signature requests")
  .action(() => {
    work = (context) => readState(context);
  });

program
  .command("initialize")
  .description("deployer-only one-off: seal the vault's EVM address into the contract config")
  .requiredOption("--vault-evm-address <address>", "the vault's EVM address (20-byte 0x hex)")
  .action((options: { vaultEvmAddress: string }) => {
    work = (context) => initialize(context, options);
  });

program
  .command("request-deposit")
  .description("record a deposit signature request on the vault's ledger; prints the request id")
  .requiredOption("--amount <amount>", "deposit amount in ERC20 base units", parseBigintArg)
  .requiredOption("--evm-nonce <nonce>", "nonce of the user's derived EVM account", parseBigintArg)
  .action((options: { amount: bigint; evmNonce: bigint }) => {
    work = async (context) => {
      console.log(await requestDeposit(context, options));
    };
  });

withPollingOptions(
  program
    .command("poll-signature-response")
    .description("poll the signet contract for the MPC's signature over a request's EVM transaction")
    .requiredOption("--request-id <hex>", "the request id to poll for", parseRequestIdArg)
    .requiredOption(
      "--expected-signer <address>",
      "EVM address the signature must recover to (the user's derived address for deposits; the vault's for withdrawals)",
    ),
).action((options: { requestId: RequestIdHex; intervalMs: number; timeoutMs: number; expectedSigner: string }) => {
  work = async (context) => {
    // Edge: a standalone command emits the tx as serialized hex for stdout.
    console.log((await pollSignatureResponse(context, options)).serialized);
  };
});

withPollingOptions(
  program
    .command("poll-respond-bidirectional")
    .description("poll the signet contract for the MPC's attestation of a request's remote EVM execution")
    .requiredOption("--request-id <hex>", "the request id to poll for", parseRequestIdArg),
).action((options: { requestId: RequestIdHex; intervalMs: number; timeoutMs: number }) => {
  work = async (context) => {
    console.log(formatRespondBidirectional(await pollRespondBidirectional(context, options)));
  };
});

program
  .command("broadcast-evm")
  .description("broadcast an MPC-signed EVM transaction; prints the transaction hash")
  .requiredOption(
    "--signed-transaction <hex>",
    "the signed, RLP-encoded EVM transaction (0x hex)",
    parseSignedTransactionArg,
  )
  .action((options: { signedTransaction: Transaction }) => {
    work = async (context) => {
      console.log(await broadcastEvm(context, { transaction: options.signedTransaction }));
    };
  });

program
  .command("claim-deposit")
  .description("claim a completed deposit: verify the MPC attestation in-circuit and mint shielded tokens")
  .requiredOption("--request-id <hex>", "the request id to claim", parseRequestIdArg)
  .action((options: { requestId: RequestIdHex }) => {
    work = (context) => claimDeposit(context, options);
  });

withPollingOptions(
  program
    .command("deposit-e2e")
    .description("full deposit flow: request → poll signed tx → broadcast → poll attestation → claim")
    .requiredOption("--amount <amount>", "deposit amount in ERC20 base units", parseBigintArg)
    .requiredOption("--evm-nonce <nonce>", "nonce of the user's derived EVM account", parseBigintArg),
).action((options: { amount: bigint; evmNonce: bigint; intervalMs: number; timeoutMs: number }) => {
  work = (context) => depositE2E(context, options);
});

program
  .command("request-withdraw")
  .description("escrow a shielded vault coin and record a withdraw signature request; prints the request id")
  .requiredOption("--amount <amount>", "withdraw amount in ERC20 base units", parseBigintArg)
  .requiredOption("--dest-evm-address <address>", "destination EVM address (20-byte 0x hex)")
  .requiredOption("--evm-nonce <nonce>", "nonce of the vault's derived EVM account", parseBigintArg)
  .action((options: { amount: bigint; destEvmAddress: string; evmNonce: bigint }) => {
    work = async (context) => {
      console.log(await requestWithdraw(context, options));
    };
  });

program
  .command("refund-withdraw")
  .description("settle a withdraw request: success is final, failure re-mints the escrow to the refund recipient")
  .requiredOption("--request-id <hex>", "the request id to settle", parseRequestIdArg)
  .action((options: { requestId: RequestIdHex }) => {
    work = (context) => refundWithdraw(context, options);
  });

withPollingOptions(
  program
    .command("withdraw-e2e")
    .description("full withdraw flow: request → poll signed tx → broadcast → poll attestation → settle")
    .requiredOption("--amount <amount>", "withdraw amount in ERC20 base units", parseBigintArg)
    .requiredOption("--dest-evm-address <address>", "destination EVM address (20-byte 0x hex)")
    .requiredOption("--evm-nonce <nonce>", "nonce of the vault's derived EVM account", parseBigintArg),
).action((options: { amount: bigint; destEvmAddress: string; evmNonce: bigint; intervalMs: number; timeoutMs: number }) => {
  work = (context) => withdrawE2E(context, options);
});

// Parse is offline: help, --version and argument errors never touch the
// network. Only when a command was actually selected do we pay for the
// wallet session + contract join.
await program.parseAsync(process.argv);
const selected = work;

if (selected !== undefined) {
  try {
    const config = getCliConfig();
    // Fail on missing config before any network connection is opened.
    requireConfigValue(config.vaultContractAddress, "MIDNIGHT_VAULT_CONTRACT_ADDRESS");

    const keys = deriveAccountKeys(config.userSeed, config.midnightNodeConfig.networkId);
    await withSyncedWalletFacade(keys, config.midnightNodeConfig, async (facade) => {
      const context = await createCliContext(config, { facade, keys });
      await selected(context);
    });
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exitCode = 1;
  }
}
