// Types for check-selfhost-literals.mjs (imported by worker/test/selfhost-literals.test.ts).
export type Violation = { file: string; line: number; rule: string };
export const RULES: [string, RegExp][];
export const SQL_RULES: [string, RegExp][];
export const HOME_RULES: [string, RegExp][];
export const ALLOW: { file: string; rule: string; reason: string }[];
export const SCAN: { dirs: string[]; files: string[] };
export function isExcluded(file: string): boolean;
export function scanText(file: string, text: string): Violation[];
