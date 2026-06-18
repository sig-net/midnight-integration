# Midnight ERC20 Vault

Cross-chain ERC20 vault between Ethereum and Midnight using the Signet MPC.

Users deposit on Midnight, the MPC signs and broadcasts an EVM `transfer()` transaction, and the user claims a **fully shielded** token on Midnight — amount and owner hidden on-chain.

The contract is generic and works with any ERC20 token. The E2E tests use USDC on Sepolia as a concrete example.

## Flow

```
User calls deposit() on Midnight (ZK proof)
        ↓
MPC detects deposit via indexer polling
        ↓
MPC builds ABI calldata + signs EVM tx (secp256k1)
        ↓
Client broadcasts signed tx to Sepolia
        ↓
MPC confirms ERC20 transfer() succeeded
        ↓
MPC signs Schnorr response (Jubjub) → broadcasts via WebSocket
        ↓
User calls claim() → contract verifies signature → mints shielded token
```

## Prerequisites

- [Midnight standalone](https://docs.midnight.network/) Docker environment
- Node.js 18+
- For E2E: MPC response server + Sepolia RPC

## Setup

```bash
npm install
cd boilerplate/contract && npm install
cd ../contract-cli && npm install
```

## Run unit tests (standalone only)

```bash
# Start Midnight standalone
docker compose -f boilerplate/contract-cli/standalone.yml up -d

# Run tests
cd boilerplate/contract-cli
npx vitest run src/test/vault.api.test.ts
```

## Deploy and run E2E

### 1. Deploy the contract

```bash
cd boilerplate/contract-cli
MPC_JUBJUB_PK_X=<...> MPC_JUBJUB_PK_Y=<...> npx tsx src/deploy-for-e2e.ts
```

The deploy script will output:
- `MIDNIGHT_CONTRACT_ADDRESS` — use this when starting the MPC and running the E2E test
- `USER_EVM_ADDRESS` — fund this address on Sepolia with ETH (for gas) and the ERC20 token you're bridging

### 2. Start the MPC response server

```bash
# In the solana-signet-program repo
MIDNIGHT_CONTRACT_ADDRESSES=<contract address from step 1> yarn response
```

### 3. Run the E2E test

```bash
cd boilerplate/contract-cli
MIDNIGHT_CONTRACT_ADDRESS=<contract address from step 1> npx vitest run src/test/vault.e2e.test.ts
```
