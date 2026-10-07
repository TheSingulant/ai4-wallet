import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const browserWeb3 = fileURLToPath(
  new URL("./node_modules/@solana/web3.js/lib/index.browser.esm.js", import.meta.url),
);

export default defineConfig({
  // Vitest uses the Node entry. The browser bundle is for the Vite app only.
  resolve: process.env.VITEST
    ? undefined
    : {
        alias: [{ find: "@solana/web3.js", replacement: browserWeb3 }],
      },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
