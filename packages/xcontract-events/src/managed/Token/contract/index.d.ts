import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
}

export type ImpureCircuits<PS> = {
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          caller_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
}

export type ProvableCircuits<PS> = {
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          caller_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
}

export type PureCircuits = {
  depositEventHash(amount_0: bigint,
                   sequence_0: bigint,
                   caller_0: { bytes: Uint8Array }): Uint8Array;
}

export type Circuits<PS> = {
  depositEventHash(context: __compactRuntime.CircuitContext<PS>,
                   amount_0: bigint,
                   sequence_0: bigint,
                   caller_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
  deposit(context: __compactRuntime.CircuitContext<PS>,
          amount_0: bigint,
          caller_0: { bytes: Uint8Array }): Promise<__compactRuntime.CircuitResults<PS, Uint8Array>>;
}

export type Ledger = {
  readonly depositCount: bigint;
  readonly lastAmount: bigint;
  emittedDeposits: {
    isEmpty(): boolean;
    size(): bigint;
    member(elem_0: Uint8Array): boolean;
    [Symbol.iterator](): Iterator<Uint8Array>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): Promise<__compactRuntime.ConstructorResult<PS>>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
export declare const expectedVk: Record<string, string>;
