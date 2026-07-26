// Protocol constants shared by the setup steps and the flow files: values
// fixed by the contracts under test, kept in one place so the TS twins
// cannot drift apart.

/**
 * The caller contract's fixed derivation path: every submit circuit uses
 * `pad(32, "caller-path")`, so ONE derived EVM sender serves all requests.
 * TS twin of the in-circuit literal.
 */
export const CALLER_PATH = "caller-path";
