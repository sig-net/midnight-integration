import path from 'node:path';
import fs from 'node:fs';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
export const currentDir = path.resolve(new URL(import.meta.url).pathname, '..');

/**
 * Auto-detect the contract directory from the source .compact file
 * This ensures we always use the current contract, not old managed directories
 */
function detectContractPath(): string {
  const contractDir = path.resolve(currentDir, '..', '..', 'contract');
  const srcDir = path.join(contractDir, 'src');

  if (!fs.existsSync(srcDir)) {
    throw new Error(`Contract source directory not found: ${srcDir}`);
  }

  const files = fs.readdirSync(srcDir);
  const compactFiles = files.filter(file => file.endsWith('.compact'));
  if (compactFiles.length === 0) {
    throw new Error(`No .compact files found in ${srcDir}`);
  }

  const contractName = path.basename(compactFiles[0], '.compact');

  // Prefer dist/managed/ (has ZK keys from full compile) over src/managed/ (--skip-zk only)
  const distManaged = path.join(contractDir, 'dist', 'managed', contractName);
  const srcManaged = path.join(srcDir, 'managed', contractName);
  const keysDir = path.join(distManaged, 'keys');

  if (fs.existsSync(keysDir)) {
    console.log(`🔍 Config: Using dist artifacts with ZK keys: ${contractName}`);
    return distManaged;
  }

  console.log(`🔍 Config: Using src artifacts (no ZK keys — run full compile for deployment): ${contractName}`);
  return srcManaged;
}

export const contractConfig = {
  privateStateStoreName: 'vault-private-state',
  zkConfigPath: detectContractPath(),
};

export interface Config {
  readonly logDir: string;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly node: string;
  readonly proofServer: string;
}

export class TestnetLocalConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', 'testnet-local', `${new Date().toISOString()}.log`);
  indexer = 'http://127.0.0.1:8088/api/v3/graphql';
  indexerWS = 'ws://127.0.0.1:8088/api/v3/graphql/ws';
  node = 'http://127.0.0.1:9944';
  proofServer = 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId('testnet');
  }
}

export class StandaloneConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', 'standalone', `${new Date().toISOString()}.log`);
  indexer = 'http://127.0.0.1:8088/api/v3/graphql';
  indexerWS = 'ws://127.0.0.1:8088/api/v3/graphql/ws';
  node = 'http://127.0.0.1:9944';
  proofServer = process.env.PROOF_SERVER_URL || 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId('undeployed');
  }
}

export class TestnetRemoteConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', 'testnet-remote', `${new Date().toISOString()}.log`);
  indexer = 'https://indexer.testnet-02.midnight.network/api/v3/graphql';
  indexerWS = 'wss://indexer.testnet-02.midnight.network/api/v3/graphql/ws';
  node = 'https://rpc.testnet-02.midnight.network';
  proofServer = 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId('testnet');
  }
}

export class PreviewConfig implements Config {
  logDir = path.resolve(currentDir, '..', 'logs', 'preview', `${new Date().toISOString()}.log`);
  indexer = 'https://indexer.preview.midnight.network/api/v4/graphql';
  indexerWS = 'wss://indexer.preview.midnight.network/api/v4/graphql/ws';
  node = 'https://rpc.preview.midnight.network';
  proofServer = 'http://127.0.0.1:6300';
  constructor() {
    setNetworkId('preview');
  }
}

export function getConfig(): Config {
  const network = process.env.MIDNIGHT_NETWORK || 'standalone';
  switch (network) {
    case 'preview':
      return new PreviewConfig();
    case 'standalone':
      return new StandaloneConfig();
    default:
      throw new Error(`Unknown MIDNIGHT_NETWORK: ${network} (use "standalone" or "preview")`);
  }
}
