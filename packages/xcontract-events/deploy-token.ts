// Deploy entrypoint (`yarn deploy:token`): deploys the token (B) and prints
// its address to set as XC_TOKEN_CONTRACT_ADDRESS for the vault deploy.
import { deployToken } from "./src/deploy.ts";

const { contractAddress } = await deployToken();
console.log(`\nXC_TOKEN_CONTRACT_ADDRESS=${contractAddress}`);
