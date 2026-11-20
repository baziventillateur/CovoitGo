// Le seul module Node utilisé par vite.config.ts (numéro de version lu dans git).
declare module 'node:child_process' {
  export function execSync(command: string, options?: { encoding?: string }): string;
}
