// Types for deploy-preflight.mjs (imported by worker/test/deploy-preflight.test.ts).
import type { Env } from "../worker/src/env";
export type Vars = Record<string, unknown>;
export type Production = { vars?: Vars; send_email?: { name?: string }[] };
export type ConfigModule = { getConfig: (env: Env) => { errors: readonly string[] }; REQUIRED_SECRETS: readonly string[] };
export type ListResult = { status: number | null; signal?: string | null; error?: { code?: string }; stdout?: string; stderr?: string };
export type Implied = { name: string; why: string };
export type Outcome = { problems: string[]; skipped: string | null };
export const PLACEHOLDERS: [string, RegExp][];
export function placeholderProblems(vars: Vars): string[];
export function impliedSecrets(vars: Vars, requiredSecrets: readonly string[]): Implied[];
export function configProblems(production: Production, vars: Vars, configModule: ConfigModule): string[];
export function secretNames(stdout: unknown): string[] | null;
export function skipReason(result: ListResult): string;
export function secretProblems(result: ListResult, implied: Implied[]): Outcome;
export function preflight(production: Production | undefined, configModule: ConfigModule, listSecrets: () => ListResult): Outcome;
export function loadConfigModule(file: string): Promise<ConfigModule>;
