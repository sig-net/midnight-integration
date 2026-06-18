import { contracts, type VaultPrivateState } from '@midnight-ntwrk/contract';
import type { Contract as CompactContract } from '@midnight-ntwrk/compact-js/effect/Contract';
import type { MidnightProviders } from '@midnight-ntwrk/midnight-js-types';
import type { DeployedContract, FoundContract } from '@midnight-ntwrk/midnight-js-contracts';

// Get the dynamic contract module
const getContractModule = () => {
  const contractNames = Object.keys(contracts);
  if (contractNames.length === 0) {
    throw new Error('No contract found in contracts object');
  }
  return contracts[contractNames[0]];
};

const contractModule = getContractModule();

export type { VaultPrivateState };
export type VaultContractInstance = InstanceType<typeof contractModule.Contract>;
export type VaultCircuits = CompactContract.ProvableCircuitId<VaultContractInstance>;

export const VaultPrivateStateId = 'vaultPrivateState';

export type VaultProviders = MidnightProviders<VaultCircuits, typeof VaultPrivateStateId, VaultPrivateState>;

export type VaultContract = VaultContractInstance;

export type DeployedVaultContract = DeployedContract<VaultContract> | FoundContract<VaultContract>;
