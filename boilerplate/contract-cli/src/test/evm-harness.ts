// Local-EVM harness: boot a Hardhat node, deploy TestUSDC, fund derived addresses.
import { ethers } from 'ethers';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EVM_DIR = path.resolve(HERE, '..', '..', '..', 'evm');
const RPC_URL = 'http://127.0.0.1:8545';

const artifact = (rel: string): { abi: any[]; bytecode: string } =>
  JSON.parse(readFileSync(path.join(EVM_DIR, 'artifacts', 'contracts', rel), 'utf8'));

const TEST_USDC = artifact('TestUSDC.sol/TestUSDC.json');

export interface EvmHarness {
  rpcUrl: string;
  chainId: bigint;
  provider: ethers.JsonRpcProvider;
  usdcAddress: string;
  /** USDC contract bound to the minter signer (can mint). */
  usdc: ethers.Contract;
  /** Mint USDC to an address. */
  mintUsdc: (to: string, amount: bigint) => Promise<void>;
  /** Send ETH (for gas) to an address. */
  fundEth: (to: string, amountWei: bigint) => Promise<void>;
  /** Tear down the Hardhat node. */
  stop: () => Promise<void>;
}

/** Spawn `hardhat node` and resolve once its JSON-RPC is accepting requests. */
const startNode = async (): Promise<{ proc: ChildProcess; provider: ethers.JsonRpcProvider }> => {
  const proc = spawn('npx', ['hardhat', 'node', '--hostname', '127.0.0.1', '--port', '8545'], {
    cwd: EVM_DIR,
    stdio: 'ignore',
    detached: false,
  });
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  for (let i = 0; i < 120; i++) {
    try {
      await provider.getBlockNumber();
      return { proc, provider };
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  proc.kill('SIGKILL');
  throw new Error('Hardhat node did not start within 60s');
};

/**
 * Start the harness: boot the node and deploy the ERC20. account[0] is the deployer and
 * funder (can mint to any address and send ETH for gas).
 */
export const startEvmHarness = async (): Promise<EvmHarness> => {
  const { proc, provider } = await startNode();
  const { chainId } = await provider.getNetwork();

  const deployer = await provider.getSigner(0);
  const factory = new ethers.ContractFactory(TEST_USDC.abi, TEST_USDC.bytecode, deployer);
  const token = await factory.deploy();
  await token.waitForDeployment();
  const usdcAddress = await token.getAddress();
  const usdc = new ethers.Contract(usdcAddress, TEST_USDC.abi, deployer);

  const mintUsdc = async (to: string, amount: bigint): Promise<void> => {
    await (await usdc.mint(to, amount)).wait();
  };
  const fundEth = async (to: string, amountWei: bigint): Promise<void> => {
    await (await deployer.sendTransaction({ to, value: amountWei })).wait();
  };
  const stop = async (): Promise<void> => {
    proc.kill('SIGKILL');
  };

  return { rpcUrl: RPC_URL, chainId, provider, usdcAddress, usdc, mintUsdc, fundEth, stop };
};
