// Locations of FreeCode's global and per-project files.
import * as os from 'node:os';
import * as path from 'node:path';

export function freecodeHome(): string {
  return process.env.FREECODE_HOME || path.join(os.homedir(), '.freecode');
}

export const globalPaths = {
  get home() {
    return freecodeHome();
  },
  get configFile() {
    return path.join(freecodeHome(), 'config.json');
  },
  get envFile() {
    return path.join(freecodeHome(), '.env');
  },
  get stateDir() {
    return path.join(freecodeHome(), 'state');
  },
  get healthFile() {
    return path.join(freecodeHome(), 'state', 'health.json');
  },
  get usageFile() {
    return path.join(freecodeHome(), 'state', 'usage.json');
  },
  get modelsCacheFile() {
    return path.join(freecodeHome(), 'cache', 'models.json');
  },
  get projectsDir() {
    return path.join(freecodeHome(), 'projects');
  },
  get historyFile() {
    return path.join(freecodeHome(), 'history.jsonl');
  },
  get commandsDir() {
    return path.join(freecodeHome(), 'commands');
  },
  get memoryFile() {
    return path.join(freecodeHome(), 'AGENTS.md');
  },
  get mcpFile() {
    return path.join(freecodeHome(), 'mcp.json');
  },
};

export function projectPaths(root: string) {
  const dir = path.join(root, '.freecode');
  return {
    dir,
    settings: path.join(dir, 'settings.json'),
    localSettings: path.join(dir, 'settings.local.json'),
    commandsDir: path.join(dir, 'commands'),
    mcpJson: path.join(root, '.mcp.json'),
    freecodeMcp: path.join(dir, 'mcp.json'),
    claudeCommandsDir: path.join(root, '.claude', 'commands'),
  };
}

/** Directory name used to store sessions for a project path. */
export function projectSlug(root: string): string {
  return root.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-120) || 'root';
}
