// Language servers (LSP): diagnostics after edits and the LSP tool. One process-wide manager:
//   getLsp()                      the shared LspManager (acquire, afterEdit, warmUp, projectDiagnostics)
//   applyLspSettings(cfg)         applies { enabled, servers, diagnosticsTimeoutMs } from the GLOBAL settings
//   diagnosticsAfterEdit(...)     short reports for files the agent just changed (never throws)
//   warmUpLanguageServer(...)     starts the server for a file the agent read
//   stopLanguageServers()         shuts every server down (app exit, project switch)
import { LspManager, type LspSettings } from './manager.js';

export { LspManager, DEFAULT_DIAGNOSTICS_TIMEOUT_MS, type LspSettings, type Acquired } from './manager.js';

let shared: LspManager | null = null;

export function getLsp(): LspManager {
  if (!shared) shared = new LspManager();
  return shared;
}

/**
 * Global settings only: lsp.servers names programs to run, so a project's own settings must never
 * reach this (see sanitizeUntrustedSettings).
 */
export function applyLspSettings(cfg: LspSettings | undefined): void {
  getLsp().configure(cfg);
}

export function isLspEnabled(): boolean {
  return getLsp().enabled;
}

export async function diagnosticsAfterEdit(files: string[], projectRoot: string, signal?: AbortSignal): Promise<(string | null)[]> {
  try {
    return await getLsp().afterEdit(files, projectRoot, signal);
  } catch {
    return files.map(() => null);
  }
}

export function warmUpLanguageServer(file: string, projectRoot: string): void {
  try {
    getLsp().warmUp(file, projectRoot);
  } catch {
    // a language server must never get in the way of reading a file
  }
}

export function stopLanguageServers(): Promise<void> {
  return shared ? shared.stopAll() : Promise.resolve();
}
