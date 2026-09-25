import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  compactDeserialize,
  compactSerialize,
  compactSerializedSize,
  type CompactType,
  type CompactValue,
} from "@sig-net/midnight-serde";

import {
  assertCompilerCoverage,
  compactTypeSource,
  type CompilerCase,
  compilerCases,
  numericBound,
} from "./compiler-cases.ts";
import {
  buildCorpus,
  type CorpusRecord,
  corpusText,
  RejectCategory,
  typeToJson,
  valueToJson,
} from "./corpus.ts";
import { NESTED, VECTORS_DEEP } from "./descriptors.ts";
import { hex } from "./oracle.ts";
import { compileFixture, CONFORMANCE_ROOT } from "./toolchain.ts";

const output = join(CONFORMANCE_ROOT, "managed-sweep");
mkdirSync(output, { recursive: true });
const compilerLimitations = [
  { name: "vectors-deep-encode", type: VECTORS_DEEP },
  { name: "nested-encode", type: NESTED },
];
assert(compilerLimitations.length > 0);
for (const limitation of compilerLimitations) {
  const declarations: string[] = [];
  const type = compactTypeSource(limitation.type, declarations);
  const source = join(output, `${limitation.name}.compact`);
  writeFileSync(
    source,
    `pragma language_version >= 0.25;\nimport CompactStandardLibrary;\n${declarations.join("\n")}\nexport pure circuit probe(v: ${type.name}): Bytes<128> { return serialize<${type.name}, 128>(v); }\n`,
  );
  assert.throws(
    () => compileFixture(source, join(output, limitation.name)),
    /Internal error/,
    limitation.name,
  );
}
for (const encode of [false, true]) {
  const name = `jubjub-${encode ? "encode" : "decode"}`;
  const source = join(output, `${name}.compact`);
  const circuit = encode
    ? "export pure circuit probe(v: JubjubScalar): Bytes<32> { return serialize<JubjubScalar, 32>(v); }"
    : "export pure circuit probe(b: Bytes<32>): JubjubScalar { return deserialize<JubjubScalar, 32>(b); }";
  writeFileSync(
    source,
    `pragma language_version >= 0.25;\nimport CompactStandardLibrary;\n${circuit}\n`,
  );
  assert.throws(() => compileFixture(source, join(output, name)), /Internal error/, name);
}
const cases = compilerCases();
assertCompilerCoverage(cases);
const compiledCases: (CompilerCase & { id: number; n: number; width: number })[] = [];
const pureCircuits: Record<string, (value: CompactValue) => CompactValue> = {};
// Separate modules bound the compiler's generated descriptor scope.
for (const [id, c] of cases.entries()) {
  const declarations: string[] = [];
  const type = compactTypeSource(c.type, declarations);
  const n = type.width + (id % 2 === 0 && c.type.kind !== "boolean" ? 0 : 3);
  const circuits = [
    `export pure circuit d${String(id)}(b: Bytes<${String(n)}>): ${type.name} { return deserialize<${type.name}, ${String(n)}>(b); }`,
  ];
  if (c.encode)
    circuits.push(
      `export pure circuit s${String(id)}(v: ${type.name}): Bytes<${String(n)}> { return serialize<${type.name}, ${String(n)}>(v); }`,
    );
  compiledCases.push({ ...c, id, n, width: type.width });
  const source = join(output, `sweep-${String(id)}.compact`);
  const managed = join(output, `managed-${String(id)}`);
  writeFileSync(
    source,
    [
      "pragma language_version >= 0.25;",
      "import CompactStandardLibrary;",
      ...declarations,
      ...circuits,
    ].join("\n") + "\n",
  );
  compileFixture(source, managed);
  const module = (await import(pathToFileURL(join(managed, "contract/index.js")).href)) as {
    pureCircuits: typeof pureCircuits;
  };
  Object.assign(pureCircuits, module.pureCircuits);
}
const records: CorpusRecord[] = buildCorpus();
let encodes = 0;
let decodes = 0;
let rejections = 0;

interface DecodeCase {
  name: string;
  type: CompactType;
  id: number;
}

function checkDecode(
  c: DecodeCase,
  bytes: Uint8Array,
  label: string,
  expectedReject?: RejectCategory,
): void {
  const circuit = pureCircuits[`d${String(c.id)}`];
  assert(circuit !== undefined);
  const options = { ignorePadding: true, lenientBooleans: true };
  let value: CompactValue;
  try {
    value = circuit(bytes);
  } catch (error) {
    assert(
      expectedReject !== undefined,
      `${c.name}: unexpected circuit rejection: ${String(error)}`,
    );
    assert.throws(() => compactDeserialize(c.type, bytes, options));
    records.push({
      record: "deserialize",
      name: `${c.name}-${label}`,
      type: typeToJson(c.type),
      bytes: hex(bytes),
      options,
      expect: { reject: expectedReject },
      provenance: "circuit",
    });
    rejections++;
    decodes++;
    return;
  }
  assert(expectedReject === undefined, `${c.name}: circuit accepted an invalid numeric encoding`);
  assert.deepEqual(
    valueToJson(c.type, compactDeserialize(c.type, bytes, options)),
    valueToJson(c.type, value),
    c.name,
  );
  records.push({
    record: "deserialize",
    name: `${c.name}-${label}`,
    type: typeToJson(c.type),
    bytes: hex(bytes),
    options,
    expect: { value: valueToJson(c.type, value) },
    provenance: "circuit",
  });
  decodes++;
}

function numericBytes(value: bigint, n: number): Uint8Array {
  let remaining = value;
  return Uint8Array.from({ length: n }, () => {
    const byte = Number(remaining & 255n);
    remaining >>= 8n;
    return byte;
  });
}

for (const c of compiledCases) {
  assert.equal(compactSerializedSize(c.type), c.width, c.name);
  for (const [index, value] of c.values.entries()) {
    const encoded = compactSerialize(c.type, value, c.n);
    assert.deepEqual(
      valueToJson(c.type, compactDeserialize(c.type, encoded)),
      valueToJson(c.type, value),
      c.name,
    );
    checkDecode(c, encoded, `value-${String(index)}`);
    if (c.encode) {
      const circuit = pureCircuits[`s${String(c.id)}`];
      assert(circuit !== undefined);
      const actual = circuit(value);
      assert(actual instanceof Uint8Array);
      assert.equal(hex(encoded), hex(actual), c.name);
      records.push({
        record: "serialize",
        name: `${c.name}-encode-${String(index)}`,
        type: typeToJson(c.type),
        value: valueToJson(c.type, value),
        packed: hex(actual.subarray(0, c.width)),
        n: c.n,
        provenance: "circuit",
      });
      encodes++;
    }
  }
  if (["uint", "field", "enum", "secp256k1-base", "secp256k1-scalar"].includes(c.type.kind)) {
    const bound = numericBound(c.type);
    const fieldReduces = c.type.kind === "secp256k1-base" || c.type.kind === "secp256k1-scalar";
    const category =
      c.type.kind === "enum"
        ? RejectCategory.EnumRange
        : c.type.kind === "uint"
          ? RejectCategory.UintRange
          : RejectCategory.FieldRange;
    for (const value of [bound - 1n, bound, bound + 1n, (1n << BigInt(c.width * 8)) - 1n]) {
      if (value >= 1n << BigInt(c.width * 8)) continue;
      checkDecode(
        c,
        numericBytes(value, c.n),
        `boundary-${String(value)}`,
        value >= bound && !fieldReduces ? category : undefined,
      );
    }
  }
  if (c.type.kind === "uint" && "bits" in c.type && c.type.bits === 12) {
    for (let value = 0; value < 65536; value++)
      checkDecode(
        c,
        numericBytes(BigInt(value), c.n),
        `exhaustive-${String(value)}`,
        value >= 4096 ? RejectCategory.UintRange : undefined,
      );
  }
  if (c.type.kind === "boolean") {
    for (let byte = 0; byte < 256; byte++) {
      for (const padding of [0, 1, 255]) {
        const bytes = new Uint8Array(c.n).fill(padding);
        bytes[0] = byte;
        checkDecode(c, bytes, `byte-${String(byte)}-pad-${String(padding)}`);
        for (const ignorePadding of [false, true])
          for (const lenientBooleans of [false, true]) {
            const options = { ignorePadding, lenientBooleans };
            const reject =
              byte > 1 && !lenientBooleans
                ? RejectCategory.BooleanStrict
                : padding !== 0 && !ignorePadding
                  ? RejectCategory.PaddingNonZero
                  : undefined;
            const expected = reject === undefined ? { value: byte === 1 } : { reject };
            if (reject === undefined)
              assert.equal(compactDeserialize(c.type, bytes, options), byte === 1);
            else assert.throws(() => compactDeserialize(c.type, bytes, options));
            records.push({
              record: "deserialize",
              name: `policy-${String(byte)}-${String(padding)}-${String(ignorePadding)}-${String(lenientBooleans)}`,
              type: typeToJson(c.type),
              bytes: hex(bytes),
              options,
              expect: expected,
              provenance: reject === undefined ? "circuit" : "twin",
            });
          }
      }
    }
  }
}
assert(
  encodes > 4000 && decodes > 65000 && rejections > 60000,
  "Compiler sweep lost operation coverage",
);
const corpusPath = join(output, "compiler-corpus.jsonl");
writeFileSync(corpusPath, corpusText(records));
console.log(
  `Compiler conformance: ${String(cases.length)} types, ${String(encodes)} encodings, ${String(decodes)} decodings, ${String(rejections)} expected circuit rejections.`,
);
console.log(`Rust replay corpus: ${corpusPath}`);
