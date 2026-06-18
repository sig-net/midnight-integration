import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  getSchnorrReduction(context: __compactRuntime.WitnessContext<Ledger, PS>,
                      challengeHash_0: bigint): [PS, [bigint, bigint]];
  callerSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
}

export type ImpureCircuits<PS> = {
  initialize(context: __compactRuntime.CircuitContext<PS>,
             sepoliaVault_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          erc20Address_0: Uint8Array,
          amount_0: bigint,
          evmChainId_0: bigint,
          evmNonce_0: bigint,
          evmGasLimit_0: bigint,
          evmMaxFee_0: bigint,
          evmPriorityFee_0: bigint,
          evmValue_0: bigint,
          caip2Id_0: Uint8Array,
          keyVersion_0: bigint,
          path_0: Uint8Array,
          algo_0: Uint8Array,
          dest_0: Uint8Array,
          params_0: Uint8Array,
          outputSchema_0: Uint8Array,
          respondSchema_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        requestId_0: Uint8Array,
        outputData_0: Uint8Array,
        pk_0: __compactRuntime.JubjubPoint,
        announcement_0: __compactRuntime.JubjubPoint,
        response_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  initialize(context: __compactRuntime.CircuitContext<PS>,
             sepoliaVault_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          erc20Address_0: Uint8Array,
          amount_0: bigint,
          evmChainId_0: bigint,
          evmNonce_0: bigint,
          evmGasLimit_0: bigint,
          evmMaxFee_0: bigint,
          evmPriorityFee_0: bigint,
          evmValue_0: bigint,
          caip2Id_0: Uint8Array,
          keyVersion_0: bigint,
          path_0: Uint8Array,
          algo_0: Uint8Array,
          dest_0: Uint8Array,
          params_0: Uint8Array,
          outputSchema_0: Uint8Array,
          respondSchema_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        requestId_0: Uint8Array,
        outputData_0: Uint8Array,
        pk_0: __compactRuntime.JubjubPoint,
        announcement_0: __compactRuntime.JubjubPoint,
        response_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
}

export type Circuits<PS> = {
  initialize(context: __compactRuntime.CircuitContext<PS>,
             sepoliaVault_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          erc20Address_0: Uint8Array,
          amount_0: bigint,
          evmChainId_0: bigint,
          evmNonce_0: bigint,
          evmGasLimit_0: bigint,
          evmMaxFee_0: bigint,
          evmPriorityFee_0: bigint,
          evmValue_0: bigint,
          caip2Id_0: Uint8Array,
          keyVersion_0: bigint,
          path_0: Uint8Array,
          algo_0: Uint8Array,
          dest_0: Uint8Array,
          params_0: Uint8Array,
          outputSchema_0: Uint8Array,
          respondSchema_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  claim(context: __compactRuntime.CircuitContext<PS>,
        requestId_0: Uint8Array,
        outputData_0: Uint8Array,
        pk_0: __compactRuntime.JubjubPoint,
        announcement_0: __compactRuntime.JubjubPoint,
        response_0: bigint): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  readonly mpcPubKeyHash: Uint8Array;
  readonly signetNonce: bigint;
  signetRequestNonce: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetCalldataFuncSig: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetCalldataArgCount: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetCalldataArgs: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetEvmTo: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetEvmChainId: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetEvmNonce: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetEvmGasLimit: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetEvmMaxFee: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetEvmPriorityFee: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetEvmValue: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetCaip2Id: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetKeyVersion: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  signetPath: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetAlgo: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetDest: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetParams: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetOutputSchema: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetRespondSchema: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  signetOutputData: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  readonly initialized: bigint;
  readonly sepoliaVaultAddress: Uint8Array;
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>,
               mpcPk_0: __compactRuntime.JubjubPoint,
               deployerCommitment_0: Uint8Array): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
