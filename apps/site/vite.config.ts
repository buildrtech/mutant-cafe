import { markdown } from "@foldkit/markdown/vite";
import { foldkit } from "@foldkit/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  publicDir: "../../assets",
  build: { manifest: true, minify: true },
  plugins: [
    markdown(),
    foldkit({
      ssr: {
        serverEntry: "/src/entry.server.ts",
        clientEntry: "/src/client/entry.ts",
        build: { prerender: true },
      },
    }),
  ],
});
