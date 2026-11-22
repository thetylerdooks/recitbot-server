import type { Env as WorkerEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      TEST_MIGRATIONS: { name: string; queries: string[] }[];
    }
    // Types `exports` from "cloudflare:workers" (the main module, reached through the assets layer).
    interface GlobalProps {
      mainModule: typeof import("../src/index");
    }
  }
}
