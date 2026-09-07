import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  // `starknet` and `@x402/core` are PEER dependencies and stay external : a
  // wallet integration brings its own starknet.js, and bundling a second copy
  // would give two `Account` classes that look alike and are not one type.
  external: ["starknet", "@x402/core"],
});
