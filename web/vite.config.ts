import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Inject the git commit the bundle was built from — shown in the GD
// easter egg ("build <sha>") so the deployed version is always verifiable.
// The Docker build passes BUILD_COMMIT as a build-arg (no .git in the
// build context); local dev falls back to git rev-parse.
function buildCommit(): string {
  if (process.env.BUILD_COMMIT) return process.env.BUILD_COMMIT;
  try {
    return execSync("git rev-parse HEAD", { cwd: fileURLToPath(new URL("..", import.meta.url)) })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

export default defineConfig({
  define: {
    __BUILD_COMMIT__: JSON.stringify(buildCommit()),
  },
  plugins: [react()],
  resolve: {
    alias: {
      // monaco-vim's dist imports this bare subpath, which monaco's exports
      // map cannot resolve; point it at a shim that re-exports the same
      // monaco instance (see src/monaco-shim.ts).
      "monaco-editor/esm/vs/editor/editor.api": fileURLToPath(
        new URL("./src/monaco-shim.ts", import.meta.url)
      ),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
        // The API validates POST origins. Keep dev-server auth same-origin
        // while the browser still talks to localhost:5173.
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("Origin", "http://localhost:3001");
          });
        },
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // monaco is big (~4MB) and rarely changes — own chunk = better caching
        manualChunks: {
          monaco: ["monaco-editor"],
        },
      },
    },
  },
});
