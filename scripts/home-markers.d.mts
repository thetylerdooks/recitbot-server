// Types for home-markers.mjs (imported by worker/test/home-markers.test.ts).
import type { HomeMarker } from "../worker/src/config";
export function homeValues(vars: Record<string, unknown>): Record<HomeMarker, string | null>;
export function toMarkers(text: string, values: Record<string, string | null>): string;
export function parseJsonc(text: string): unknown;
