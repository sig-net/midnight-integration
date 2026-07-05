# ERC20 Vault Integration Tests

These integration tests drive the cli `@midnight-erc20-vault/cli` to fully integration test the contracts.

## Prerequisites
- compact compiler
- midnight stack running [indexer, midnight node, etc.]
- 

## Configuration
- midnight node configuration with: packages/lib/src/midnight-node-config.ts

## Tests/Scripts? not sure best way to order this (inspired directly by /Users/bernard/Projects/github.com/sig-net/midnight-erc20-vault-refactor/docs/e2e-sepolia-runbook.md)
- env. check:
  - confirm midnight stack is accessible
  - compact compiler present on path
  - minimal env var check
    - SEPOLIA_RPC_URL
- setup
    - compile contracts
        - vault
            - skips if MIDNIGHT_VAULT_CONTRACT_ADDRESS is given, just logs saying skipping due to address
            - compiles with npm:compile:vault:zk
    - deploy contracts
        - vault
            - skips if MIDNIGHT_VAULT_CONTRACT_ADDRESS is given in environment, just logs saying skippping due to address
            - deploys with npm:deploy:vault which yields contract address
            - Prints VERY CLEARLY MIDNIGHT_VAULT_CONTRACT_ADDRESS. Prints out to add to env file to skip in subsequent runs.
            - stores contract address at MIDNIGHT_VAULT_CONTRACT_ADDRESS in environment for subsequent steps
    - derive MPC root key
        - skips if MPC_ROOT_KEY is given, just logs out saying skipping
        - otherwise generates with MPC_ROOT_KEY=0x$(openssl rand -hex 32), add some helper for this perhaps to packages/signet-midnight
        - stores derived address at MPC_ROOT_KEY for subsequent steps
    - derive mpc keys
        - skips if MPC_JUBJUB_PK_X, MPC_JUBJUB_PK_Y, MPC_SECP256K1_PUBKEY present in the environment
        - otherwise generates as done here: /Users/bernard/Projects/github.com/sig-net/midnight-erc20-vault/boilerplate/contract-cli/src/derive-mpc-keys.ts (port this tools to packages/signet-midnight with clear comments saying this should be in github.com/sig-net/signet.js)
        - store in environment for subsequent steps
    - derive vault evm address
        - skips if EVM_VAULT_ADDRESS is given, just logs out saying skipping
        - derive as done at /Users/bernard/Projects/github.com/sig-net/midnight-erc20-vault/boilerplate/contract-cli/src/deploy-for-e2e.ts:63 - store in environment for subsequent steps
        - prints out VERY CLEARLY the EVM_VAULT_ADDRESS. Prints out to add to env file to skip in subsequent runs.
        - stores derived address at EVM_VAULT_ADDRESS in the environment for subsequent steps.
    - derive user evm address
        - same as 'derive vault evm address'. just EVM_USER_ADDRESS instead
    - MPC server configuration print
        - Print out MPC_ROOT_KEY, MIDNIGHT_VAULT_CONTRACT_ADDRESS, say that these need to be added to the mpc server as MPC_ROOT_KEY and MIDNIGHT_CONTRACT_ADDRESSES(comma separated if we add more in future) respectively
        - Print out that the server needs to be started!! i.e. `yarn response` in the github.com/sig-net/solana-signet-program repo
- runs initialisation test --> placeholder for now        
- runs deposit test
    - mostly placeholder for now just!
    - confirm that EVM_USER_ADDRESS is funded with ETH 0.01, otherwise fail
    - confirm that EVM_USER_ADDRESS is funed with USDC 0.1, otherwise fail

## NOTES:
- port 
- port the deriveEvmAddress function to packages/signet-midnight with clear comments saying this should be in github.com/sig-net/signet.js
- port Jub jub derivation to packages/signet-midnight with clear comments saying this should be in github.com/sig-net/signet.js
- ideally print out a full block of minimal env vars to have in the environment for this thing to work
- use `import { ethers } from 'ethers';` ethereum library for ethereum interactions
- DEPLOYER_SEED: seed of user performing deploy, parses to midnight wallet, defaults to 0000000000000000000000000000000000000000000000000000000000000001 if not given. Log these out somewhere?
- USER_SEED: seed of user performing the method calls. defaults to 0000000000000000000000000000000000000000000000000000000000000001 if not given. Log these out somewhere?
- port /Users/bernard/Projects/github.com/BRBussy/midday/docker-compose.yaml to root of this repository for use when starting the env. Use latest versions of containers