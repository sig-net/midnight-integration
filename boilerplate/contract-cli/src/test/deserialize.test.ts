/**
 * Midnight Deserialization Test
 *
 * Verifies that a Compact contract can correctly read all Solidity return
 * types from a Bytes<4096> buffer using slice<N> + as Field.
 *
 * The byte buffers match exactly what OutputSerializer.serializeMidnight()
 * produces in the MPC response server. This is the Compact-side round-trip
 * test — the serializer-side tests live in the response server repo.
 *
 * Runs locally using the compiled Compact JS simulator — no devnet required.
 *
 * testDeserialize layout (all values 32-byte LE unless noted):
 *   offset 0:   bool
 *   offset 32:  uint256
 *   offset 64:  address (20-byte value in 32-byte LE slot)
 *   offset 96:  uint128
 *   offset 128: string  (32-byte LE length + 128-byte payload)
 *   offset 288: uint256[] (32-byte LE count + 3×32-byte LE elements, maxItems=3)
 *   offset 416: bytes32 (raw 32 bytes, NOT LE integer)
 *   offset 448: bytes   (32-byte LE length + 64-byte raw payload)
 *
 * testMultiReturn layout (simulates (bool, uint256, address) EVM return):
 *   offset 0:   bool
 *   offset 32:  uint256
 *   offset 64:  address
 */

import { createConstructorContext, createCircuitContext, dummyContractAddress } from '@midnight-ntwrk/compact-runtime';
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const contractPath = path.resolve(__dirname, '../../../contract/src/managed/test-deserialize/contract/index.js');
const { Contract, ledger } = await import(contractPath);

const DATA_SIZE = 4096;

function bigintToBytes32LE(n: bigint): Uint8Array {
  const bytes = new Uint8Array(32);
  let val = n < 0n ? -n : n;
  for (let i = 0; i < 32 && val > 0n; i++) {
    bytes[i] = Number(val & 0xffn);
    val >>= 8n;
  }
  return bytes;
}

function readBytes32LE(data: Uint8Array, offset: number): bigint {
  let result = 0n;
  for (let i = 31; i >= 0; i--) {
    result = (result << 8n) | BigInt(data[offset + i]);
  }
  return result;
}

function initContract() {
  const contract = new Contract({});
  const dummyCoinPK = new Uint8Array(32);
  const ctxCtor = createConstructorContext(undefined, dummyCoinPK);
  const initResult = contract.initialState(ctxCtor);
  return { contract, dummyCoinPK, initResult };
}

function runCircuit(data: Uint8Array) {
  const { contract, dummyCoinPK, initResult } = initContract();
  const circuitCtx = createCircuitContext(
    dummyContractAddress(),
    dummyCoinPK,
    initResult.currentContractState.data,
    undefined,
  );
  const result = contract.circuits.testDeserialize(circuitCtx, data);
  return ledger(result.context.currentQueryContext.state);
}

function runMultiReturnCircuit(data: Uint8Array) {
  const { contract, dummyCoinPK, initResult } = initContract();
  const circuitCtx = createCircuitContext(
    dummyContractAddress(),
    dummyCoinPK,
    initResult.currentContractState.data,
    undefined,
  );
  const result = contract.circuits.testMultiReturn(circuitCtx, data);
  return ledger(result.context.currentQueryContext.state);
}

// Test values — chosen to exercise edge cases
const TEST_BOOL = true;
const TEST_UINT256 = 2n ** 200n + 42n;
const TEST_ADDRESS = BigInt('0x14a6Abe86c64FbE0Ee0931a80Fc1381E872Bf5ab');
const TEST_UINT128 = 999_999_999_999n;
const TEST_STRING = 'USDC';
const TEST_ARR = [100n, 200n];
const TEST_BYTES32_FIRST = 0xab;
const TEST_BYTES32_LAST = 0xcd;
const TEST_DYN_BYTES = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0xca, 0xfe]);

function buildTestData(): Uint8Array {
  const data = new Uint8Array(DATA_SIZE);

  // bool at offset 0
  data.set(bigintToBytes32LE(TEST_BOOL ? 1n : 0n), 0);

  // uint256 at offset 32
  data.set(bigintToBytes32LE(TEST_UINT256), 32);

  // address at offset 64
  data.set(bigintToBytes32LE(TEST_ADDRESS), 64);

  // uint128 at offset 96
  data.set(bigintToBytes32LE(TEST_UINT128), 96);

  // string at offset 128: 32-byte LE length + 128-byte payload
  const strBytes = new TextEncoder().encode(TEST_STRING);
  data.set(bigintToBytes32LE(BigInt(strBytes.length)), 128);
  data.set(strBytes, 160);

  // uint256[] at offset 288: 32-byte LE count + elements
  data.set(bigintToBytes32LE(BigInt(TEST_ARR.length)), 288);
  for (let i = 0; i < TEST_ARR.length; i++) {
    data.set(bigintToBytes32LE(TEST_ARR[i]), 320 + i * 32);
  }

  // bytes32 at offset 416: raw bytes (NOT LE integer)
  data[416] = TEST_BYTES32_FIRST;
  data[447] = TEST_BYTES32_LAST;

  // dynamic bytes at offset 448: 32-byte LE length + 64-byte payload
  data.set(bigintToBytes32LE(BigInt(TEST_DYN_BYTES.length)), 448);
  data.set(TEST_DYN_BYTES, 480);

  return data;
}

describe('Compact deserialization of Midnight serialization format', () => {
  let l: ReturnType<typeof ledger>;

  beforeAll(() => {
    const data = buildTestData();
    l = runCircuit(data);
  });

  it('reads bool correctly', () => {
    expect(readBytes32LE(l.resultBool, 0)).toBe(1n);
  });

  it('reads uint256 correctly (large value)', () => {
    expect(readBytes32LE(l.resultUint256, 0)).toBe(TEST_UINT256);
  });

  it('reads address correctly', () => {
    expect(readBytes32LE(l.resultAddress, 0)).toBe(TEST_ADDRESS);
  });

  it('reads uint128 correctly', () => {
    expect(readBytes32LE(l.resultUint128, 0)).toBe(TEST_UINT128);
  });

  it('reads string length correctly', () => {
    expect(readBytes32LE(l.resultStrLen, 0)).toBe(BigInt(TEST_STRING.length));
  });

  it('reads string payload correctly', () => {
    const expected = new TextEncoder().encode(TEST_STRING);
    for (let i = 0; i < expected.length; i++) {
      expect(l.resultStrData[i]).toBe(expected[i]);
    }
    expect(l.resultStrData[expected.length]).toBe(0);
  });

  it('reads array count correctly', () => {
    expect(readBytes32LE(l.resultArrCount, 0)).toBe(BigInt(TEST_ARR.length));
  });

  it('reads array element 0 correctly', () => {
    expect(readBytes32LE(l.resultArrElem0, 0)).toBe(TEST_ARR[0]);
  });

  it('reads array element 1 correctly', () => {
    expect(readBytes32LE(l.resultArrElem1, 0)).toBe(TEST_ARR[1]);
  });

  it('reads unused array slot as zero', () => {
    expect(readBytes32LE(l.resultArrElem2, 0)).toBe(0n);
  });

  it('reads bytes32 raw bytes correctly', () => {
    expect(l.resultBytes32[0]).toBe(TEST_BYTES32_FIRST);
    expect(l.resultBytes32[31]).toBe(TEST_BYTES32_LAST);
  });

  it('reads dynamic bytes length correctly', () => {
    expect(readBytes32LE(l.resultDynBytesLen, 0)).toBe(BigInt(TEST_DYN_BYTES.length));
  });

  it('reads dynamic bytes payload correctly', () => {
    for (let i = 0; i < TEST_DYN_BYTES.length; i++) {
      expect(l.resultDynBytesData[i]).toBe(TEST_DYN_BYTES[i]);
    }
    expect(l.resultDynBytesData[TEST_DYN_BYTES.length]).toBe(0);
  });
});

describe('Compact deserialization — bool=false', () => {
  it('reads false as 0', () => {
    const data = new Uint8Array(DATA_SIZE);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultBool, 0)).toBe(0n);
  });
});

describe('Compact deserialization — zero values', () => {
  it('reads all-zero buffer without error', () => {
    const data = new Uint8Array(DATA_SIZE);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultBool, 0)).toBe(0n);
    expect(readBytes32LE(l.resultUint256, 0)).toBe(0n);
    expect(readBytes32LE(l.resultAddress, 0)).toBe(0n);
    expect(readBytes32LE(l.resultUint128, 0)).toBe(0n);
    expect(readBytes32LE(l.resultStrLen, 0)).toBe(0n);
    expect(readBytes32LE(l.resultArrCount, 0)).toBe(0n);
    expect(readBytes32LE(l.resultDynBytesLen, 0)).toBe(0n);
  });
});

describe('Compact deserialization — large uint256', () => {
  it('reads a value near Field max correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    const nearMax = 2n ** 253n - 1n;
    data.set(bigintToBytes32LE(nearMax), 32);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultUint256, 0)).toBe(nearMax);
  });
});

describe('Compact deserialization — long string', () => {
  it('reads a 100-byte string correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    const longStr = 'A'.repeat(100);
    const strBytes = new TextEncoder().encode(longStr);
    data.set(bigintToBytes32LE(BigInt(strBytes.length)), 128);
    data.set(strBytes, 160);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultStrLen, 0)).toBe(100n);
    for (let i = 0; i < 100; i++) {
      expect(l.resultStrData[i]).toBe(0x41);
    }
    expect(l.resultStrData[100]).toBe(0);
  });
});

describe('Compact deserialization — full array', () => {
  it('reads 3 elements (maxItems=3)', () => {
    const data = new Uint8Array(DATA_SIZE);
    data.set(bigintToBytes32LE(3n), 288);
    data.set(bigintToBytes32LE(111n), 320);
    data.set(bigintToBytes32LE(222n), 352);
    data.set(bigintToBytes32LE(333n), 384);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultArrCount, 0)).toBe(3n);
    expect(readBytes32LE(l.resultArrElem0, 0)).toBe(111n);
    expect(readBytes32LE(l.resultArrElem1, 0)).toBe(222n);
    expect(readBytes32LE(l.resultArrElem2, 0)).toBe(333n);
  });
});

describe('Compact deserialization — Sepolia USDC address', () => {
  it('reads Circle USDC address correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    const usdcAddr = BigInt('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');
    data.set(bigintToBytes32LE(usdcAddr), 64);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultAddress, 0)).toBe(usdcAddr);
  });
});

describe('Compact deserialization — dynamic bytes', () => {
  it('reads 32-byte payload correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    const payload = new Uint8Array(32);
    for (let i = 0; i < 32; i++) payload[i] = i;
    data.set(bigintToBytes32LE(32n), 448);
    data.set(payload, 480);
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultDynBytesLen, 0)).toBe(32n);
    for (let i = 0; i < 32; i++) {
      expect(l.resultDynBytesData[i]).toBe(i);
    }
  });

  it('reads empty bytes correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    // length = 0, no payload
    const l = runCircuit(data);
    expect(readBytes32LE(l.resultDynBytesLen, 0)).toBe(0n);
  });
});

// ---- Multi-value return tests ----
// Simulates EVM functions that return multiple values, e.g.:
//   function getInfo() returns (bool success, uint256 amount, address recipient)
// The serializer writes each value at sequential 32-byte offsets.
// The Compact contract reads each with slice<32> at the correct offset.

describe('Compact deserialization — multiple return values (bool, uint256, address)', () => {
  const MULTI_BOOL = true;
  const MULTI_AMOUNT = 1_000_000n;
  const MULTI_ADDR = BigInt('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238');

  function buildMultiReturnData(): Uint8Array {
    const data = new Uint8Array(DATA_SIZE);
    data.set(bigintToBytes32LE(MULTI_BOOL ? 1n : 0n), 0);
    data.set(bigintToBytes32LE(MULTI_AMOUNT), 32);
    data.set(bigintToBytes32LE(MULTI_ADDR), 64);
    return data;
  }

  let l: ReturnType<typeof ledger>;

  beforeAll(() => {
    l = runMultiReturnCircuit(buildMultiReturnData());
  });

  it('reads bool at offset 0', () => {
    expect(readBytes32LE(l.multiBool, 0)).toBe(1n);
  });

  it('reads uint256 at offset 32', () => {
    expect(readBytes32LE(l.multiUint256, 0)).toBe(MULTI_AMOUNT);
  });

  it('reads address at offset 64', () => {
    expect(readBytes32LE(l.multiAddress, 0)).toBe(MULTI_ADDR);
  });
});

describe('Compact deserialization — multi-return with false + zero', () => {
  it('reads (false, 0, 0x0) correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    // All zeros — bool=false, amount=0, address=0x0
    const l = runMultiReturnCircuit(data);
    expect(readBytes32LE(l.multiBool, 0)).toBe(0n);
    expect(readBytes32LE(l.multiUint256, 0)).toBe(0n);
    expect(readBytes32LE(l.multiAddress, 0)).toBe(0n);
  });
});

describe('Compact deserialization — multi-return with large amount', () => {
  it('reads (true, 2^200, USDC address) correctly', () => {
    const data = new Uint8Array(DATA_SIZE);
    const largeAmount = 2n ** 200n;
    const addr = BigInt('0x14a6Abe86c64FbE0Ee0931a80Fc1381E872Bf5ab');
    data.set(bigintToBytes32LE(1n), 0);
    data.set(bigintToBytes32LE(largeAmount), 32);
    data.set(bigintToBytes32LE(addr), 64);
    const l = runMultiReturnCircuit(data);
    expect(readBytes32LE(l.multiBool, 0)).toBe(1n);
    expect(readBytes32LE(l.multiUint256, 0)).toBe(largeAmount);
    expect(readBytes32LE(l.multiAddress, 0)).toBe(addr);
  });
});
