// Deploy entrypoint (`yarn deploy:vault`): deploys the vault (A) referencing
// an already-deployed token. Reads the token address from
// XC_TOKEN_CONTRACT_ADDRESS.
import { deployVault } from "./src/deploy.ts";

const tokenAddress = process.env.XC_TOKEN_CONTRACT_ADDRESS?.trim();
if (!tokenAddress) {
  throw new Error("XC_TOKEN_CONTRACT_ADDRESS is required (deploy the token first: yarn deploy:token)");
}
const { contractAddress } = await deployVault(tokenAddress);
console.log(`\nXC_VAULT_CONTRACT_ADDRESS=${contractAddress}`);
