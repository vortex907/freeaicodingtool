// Loads MCP server configs, starts the servers and exposes their tools to the agent.
import type { McpServerConfig, Settings } from '../config/config.js';
import { globalPaths, projectPaths } from '../config/paths.js';
import { readJsonSync } from '../util/fs.js';
import { McpClient, type McpCallResult, type McpTool } from './client.js';
import type { Tool, ToolResult } from '../tools/types.js';
import { errorResult, fail } from '../tools/types.js';
import { truncate } from '../util/strings.js';
import { sanitizeSchema } from '../providers/wire.js';

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: string;
  /** Project-level server that the user has not approved yet. */
  needsApproval: boolean;
}

/** Collects MCP server definitions from all config locations. */
export function loadMcpConfigs(settings: Settings, projectRoot: string, trusted: boolean): McpServerEntry[] {
  const out = new Map<string, McpServerEntry>();
  const add = (servers: Record<string, McpServerConfig> | undefined, source: string, project: boolean) => {
    for (const [name, config] of Object.entries(servers ?? {})) {
      if (!config || config.disabled) continue;
      const approved = !project || trusted || (settings.approvedMcpServers ?? []).includes(name);
      out.set(name, { name, config, source, needsApproval: !approved });
    }
  };
  add(readJsonSync<{ mcpServers?: Record<string, McpServerConfig> }>(globalPaths.mcpFile, {}).mcpServers, globalPaths.mcpFile, false);
  add(settings.mcpServers, 'settings', false);
  const pp = projectPaths(projectRoot);
  add(readJsonSync<{ mcpServers?: Record<string, McpServerConfig> }>(pp.mcpJson, {}).mcpServers, pp.mcpJson, true);
  add(readJsonSync<{ mcpServers?: Record<string, McpServerConfig> }>(pp.freecodeMcp, {}).mcpServers, pp.freecodeMcp, true);
  return [...out.values()];
}

function toolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '_');
  let name = `mcp__${clean(server)}__${clean(tool)}`;
  if (name.length > 64) name = name.slice(0, 64);
  return name;
}

function resultToText(r: McpCallResult): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text' && c.text !== undefined) parts.push(c.text);
    else if (c.type === 'image') parts.push(`[image ${c.mimeType ?? ''} omitted]`);
    else if (c.type === 'audio') parts.push('[audio omitted]');
    else if (c.type === 'resource') parts.push(c.resource?.text ?? `[resource ${c.resource?.uri ?? ''}]`);
    else if (c.type === 'resource_link') parts.push(`[resource link ${(c as { uri?: string }).uri ?? ''}]`);
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join('\n') || '(no content)';
}

export class McpManager {
  clients = new Map<string, McpClient>();
  entries: McpServerEntry[] = [];
  onChange?: () => void;

  constructor(private projectRoot: string) {}

  /** Starts all approved servers in the background. */
  start(entries: McpServerEntry[]): Promise<void> {
    this.entries = entries;
    const starts = entries
      .filter((e) => !e.needsApproval)
      .map(async (e) => {
        const client = new McpClient(e.name, e.config, this.projectRoot);
        client.onToolsChanged = () => this.onChange?.();
        this.clients.set(e.name, client);
        try {
          await client.start();
        } catch {
          // status/error are kept on the client for /mcp
        }
        this.onChange?.();
      });
    return Promise.all(starts).then(() => undefined);
  }

  async startOne(entry: McpServerEntry): Promise<McpClient> {
    this.clients.get(entry.name)?.close();
    const client = new McpClient(entry.name, entry.config, this.projectRoot);
    client.onToolsChanged = () => this.onChange?.();
    this.clients.set(entry.name, client);
    try {
      await client.start();
    } catch {
      // keep failed status
    }
    this.onChange?.();
    return client;
  }

  /** Tools from all ready servers, adapted to FreeCode's Tool interface. */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const client of this.clients.values()) {
      if (client.status !== 'ready') continue;
      for (const t of client.tools) out.push(this.adapt(client, t));
    }
    return out;
  }

  instructions(): string[] {
    const out: string[] = [];
    for (const c of this.clients.values()) if (c.status === 'ready' && c.instructions) out.push(`## MCP server "${c.name}"\n${c.instructions.slice(0, 2000)}`);
    return out;
  }

  private adapt(client: McpClient, t: McpTool): Tool {
    const name = toolName(client.name, t.name);
    const schema = (sanitizeSchema(t.inputSchema ?? { type: 'object', properties: {} }, 'openai') as Record<string, unknown>) ?? {};
    if (schema.type !== 'object') schema.type = 'object';
    if (!schema.properties) schema.properties = {};
    const readOnly = t.annotations?.readOnlyHint === true;
    return {
      name,
      category: 'mcp',
      parallelSafe: readOnly,
      planSafe: readOnly,
      description: truncate(`[MCP ${client.name}] ${t.description ?? t.annotations?.title ?? t.name}`, 1200),
      parameters: schema,
      label: (input) => `${client.name}:${t.name}(${truncate(JSON.stringify(input), 60)})`,
      prepare: async (input, ctx) => {
        if (client.status !== 'ready') return errorResult(`MCP server ${client.name} is not running (${client.error ?? client.status}).`);
        return {
          permission: {
            tool: name,
            category: 'mcp',
            title: `MCP tool ${client.name} › ${t.name}`,
            subject: truncate(JSON.stringify(input), 300),
            description: t.description ? truncate(t.description, 200) : undefined,
            readOnly,
            ruleSuggestion: name,
            ruleLabel: `${client.name} › ${t.name}`,
          },
          execute: async (): Promise<ToolResult> => {
            try {
              const r = await client.callTool(t.name, input, ctx.signal);
              const text = resultToText(r);
              const content = text.length > 40_000 ? text.slice(0, 40_000) + '\n[... truncated ...]' : text;
              return { content, isError: !!r.isError, display: { kind: 'text', text: content, maxLines: 6, dim: true } };
            } catch (e) {
              return fail(`MCP tool ${t.name} failed: ${(e as Error).message}`);
            }
          },
        };
      },
    };
  }

  closeAll(): void {
    for (const c of this.clients.values()) c.close();
  }
}
