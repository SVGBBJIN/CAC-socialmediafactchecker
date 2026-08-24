import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm", "cjs"],
  outExtension({ format }) {
    return { js: format === "esm" ? ".es.js" : ".js" };
  },
  dts: true,
  sourcemap: false,
  clean: true,
  external: ["react", "react-dom"],
  loader: { ".css": "copy" },
  publicDir: false,
  onSuccess: async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    fs.mkdirSync("dist", { recursive: true });
    // Concatenate tokens + every component's CSS into one flat dist/styles.css — avoids
    // shipping a relative @import chain the design-sync converter would have to resolve
    // against a src/ tree that isn't part of the published package.
    const order = [
      "src/tokens.css",
      "src/components/Sidebar.css",
      "src/components/LibraryItem.css",
      "src/components/EntryBar.css",
      "src/components/VerdictBadge.css",
      "src/components/TimestampChip.css",
      "src/components/SourcePill.css",
      "src/components/ClaimCard.css",
      "src/components/Button.css",
    ];
    const combined = order.map((f) => fs.readFileSync(f, "utf8")).join("\n\n");
    fs.writeFileSync(path.join("dist", "styles.css"), combined);
  },
});
