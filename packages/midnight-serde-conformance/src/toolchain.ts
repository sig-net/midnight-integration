import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import runtimePackage from "@midnight-ntwrk/compact-runtime/package.json" with { type: "json" };

/** Release whose compiler binaries define the corpus layout. */
export const COMPACTC_VERSION = "0.33.0-rc.2";

/** Pinned compact-runtime version used by generated circuit JavaScript. */
export const RUNTIME_VERSION = "0.18.0-rc.1";

/** SHA-256 of compactc.bin for each verified build of the pinned release. */
export const COMPILER_BUILDS: Readonly<Record<string, string>> = {
  "darwin-arm64": "6945dd50bef946f054bca6e2aafa60a07b002e07809dffd3a7389602a627bae5",
  "linux-x64": "8f1622cb32b4e55343b02eb20ecac47be7f33f86acaf8b5a0cff79d046ddb38d",
};

/** Identity of the compiler run that produced a managed fixture. */
export interface CompilationIdentity {
  release: string;
  build: string;
  compilerSha256: string;
  runtime: string;
  fixtureSha256: string;
  outputSha256: string;
}

/**
 * SHA-256 of a source or generated artifact.
 *
 * @param path - File to hash.
 * @returns Lowercase SHA-256 hex.
 */
export function fileSha256(path: string | URL): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Resolve and verify the compiler executable used by fixture compilation.
 *
 * @returns The verified compiler wrapper path.
 * @throws {Error} If the compiler binary or runtime differs from the pin.
 */
export function verifiedCompiler(): string {
  const compiler = realpathSync(
    join(process.env.COMPACT_DIRECTORY ?? join(homedir(), ".compact"), "bin/compactc"),
  );
  const build = `${process.platform}-${process.arch}`;
  const expected = COMPILER_BUILDS[build];
  if (expected === undefined || fileSha256(join(dirname(compiler), "compactc.bin")) !== expected) {
    throw new Error(`Unverified compactc build ${build}. Expected release ${COMPACTC_VERSION}.`);
  }
  if (runtimePackage.version !== RUNTIME_VERSION) {
    throw new Error(`Expected compact-runtime ${RUNTIME_VERSION}, got ${runtimePackage.version}`);
  }
  return compiler;
}

/**
 * Compile fixtures with the verified binary and record artifact identity.
 *
 * @param source - Compact source file.
 * @param output - Generated output directory.
 * @returns Identity of the completed compilation.
 */
export function compileFixture(source: string, output: string): CompilationIdentity {
  const compiler = verifiedCompiler();
  execFileSync(compiler, ["--skip-zk", "--feature-zkir-v3", source, output], { stdio: "pipe" });
  const identity: CompilationIdentity = {
    release: COMPACTC_VERSION,
    build: `${process.platform}-${process.arch}`,
    compilerSha256: fileSha256(join(dirname(compiler), "compactc.bin")),
    runtime: RUNTIME_VERSION,
    fixtureSha256: fileSha256(source),
    outputSha256: fileSha256(join(output, "contract/index.js")),
  };
  writeFileSync(join(output, "compiler-identity.json"), JSON.stringify(identity) + "\n");
  return identity;
}

/**
 * Verify that the managed fixture matches its recorded compilation.
 *
 * @returns The verified fixture identity.
 * @throws {Error} If identity, source, generated output or runtime has drifted.
 */
export function fixtureIdentity(): CompilationIdentity {
  const identity = JSON.parse(
    readFileSync(new URL("../managed/compiler-identity.json", import.meta.url), "utf8"),
  ) as CompilationIdentity;
  assertCompilationIdentity(
    identity,
    fileSha256(new URL("../serde-fixtures.compact", import.meta.url)),
    fileSha256(new URL("../managed/contract/index.js", import.meta.url)),
  );

  return identity;
}

/** Absolute path of the conformance package. */
export const CONFORMANCE_ROOT = fileURLToPath(new URL("../", import.meta.url));

/**
 * Check the identity against the pinned release and current artifact hashes.
 *
 * @param identity - Recorded compilation identity.
 * @param sourceHash - Current source SHA-256.
 * @param outputHash - Current generated JavaScript SHA-256.
 * @throws {Error} If any identity component differs.
 */
export function assertCompilationIdentity(
  identity: CompilationIdentity,
  sourceHash: string,
  outputHash: string,
): void {
  if (
    identity.release !== COMPACTC_VERSION ||
    identity.runtime !== RUNTIME_VERSION ||
    runtimePackage.version !== RUNTIME_VERSION ||
    COMPILER_BUILDS[identity.build] === undefined ||
    identity.compilerSha256 !== COMPILER_BUILDS[identity.build] ||
    identity.fixtureSha256 !== sourceHash ||
    identity.outputSha256 !== outputHash
  ) {
    throw new Error("Fixture compilation identity mismatch. Recompile with the pinned toolchain.");
  }
}
