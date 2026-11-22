import type { Env } from "../env";
import { assignUsername as assign } from "../username";

/** A new OAuth account gets its username at sign-up, from the email's local part (username.ts). */
export async function assignUsername(env: Env, accountId: string, email: string): Promise<void> {
  await assign(env.DB, accountId, email);
}
