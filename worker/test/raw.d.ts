/** Vite raw imports: page.test.ts reads the shipped static files as text. */
declare module "*?raw" {
  const text: string;
  export default text;
}

/** Vite's import.meta.glob, as selfhost-literals.test.ts uses it (eager raw text). */
interface ImportMeta {
  glob(patterns: string | string[], options: { query: "?raw"; import: "default"; eager: true }): Record<string, string>;
}
