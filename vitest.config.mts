import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
import fs from "node:fs";
import path from "node:path";

function loadEnv(filePath: string) {
  const env: Record<string, string> = {};
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, "utf-8");
    content.split("\n").forEach((line) => {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) {
        const key = match[1].trim();
        const value = match[2].trim().replace(/^["']|["']$/g, "");
        env[key] = value;
      }
    });
  }
  return env;
}

const envVars = loadEnv(path.resolve(__dirname, ".env.local"));

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: envVars,
        },
      },
    },
  },
});
