// Only Bun's test module, not the rest of @types/bun: its globals disagree with the DOM lib this
// tsconfig builds against (see the local Bun.build shim in scripts/build-sw.ts).
/// <reference types="bun-types/test" />
