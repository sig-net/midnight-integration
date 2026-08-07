// Unit tests for the raw-state tree walk: the resolved ledger-tree path
// follower every signet reader uses. Pins the path shape contract
// (empty path, the one-field bare-root fallback, non-array and out-of-range
// steps) and the `{ state }` wrapper unwrap.

import { StateValue } from "@midnight-ntwrk/compact-runtime";
import { describe, expect, it } from "vitest";

import { signetFieldNodeByPath } from "../src/index.ts";

/** A minimal one-atom cell, the non-array node a one-field contract stores as its root. */
const rootCell = (): StateValue =>
  StateValue.newCell({
    value: [new Uint8Array([1])],
    alignment: [{ tag: "atom", value: { tag: "bytes", length: 1 } }],
  });

describe("signetFieldNodeByPath", () => {
  it("throws for an empty path", () => {
    expect(() => signetFieldNodeByPath(StateValue.newArray(), [])).toThrow(/path is empty/);
  });

  it("returns the bare non-array root itself at a final [0]", () => {
    const cell = rootCell();
    expect(signetFieldNodeByPath(cell, [0])).toBe(cell);
  });

  it("throws when a mid-path step lands on a non-array", () => {
    const root = StateValue.newArray().arrayPush(rootCell());
    expect(() => signetFieldNodeByPath(root, [0, 5])).toThrow(/steps into a non-array/);
  });

  it("throws when an index is out of range", () => {
    const root = StateValue.newArray().arrayPush(StateValue.newArray());
    expect(() => signetFieldNodeByPath(root, [0, 0])).toThrow(/out of range/);
  });

  it("unwraps a { state } wrapper like a bare state value", () => {
    const root = StateValue.newArray().arrayPush(rootCell());
    const bare = signetFieldNodeByPath(root, [0]);
    const wrapped = signetFieldNodeByPath({ state: root }, [0]);
    // The resolved node is the same logical cell either way (the state layer
    // hands out fresh JS wrappers, so compare cell contents, not identity).
    expect(wrapped.asCell()).toEqual(bare.asCell());
  });
});
