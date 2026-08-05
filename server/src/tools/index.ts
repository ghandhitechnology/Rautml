// ToolDef registry. Order is load-bearing: it is the exact order of
// CONTRACT.md § Tools (1–11), and it is the order the tool list is advertised
// to the model in.
//
//  1. web_search             3. image_search        (research.ts)
//  2. web_fetch
//  4. bash_tool   5. create_file   6. str_replace
//  7. view        8. present_files                  (workspace.ts)
//  9. visualize_read_me  10. visualize_show_widget
// 11. ask_user_input_v0                             (ux.ts)
// 12. spawn_subagents                               (subagents.ts)
// 13. list_sources  14. search_sources  15. read_source  (sources.ts)
import type { ToolDef } from '../types.js';
import { researchTools } from './research.js';
import { workspaceTools } from './workspace.js';
import { uxTools } from './ux.js';
import { subagentTools } from './subagents.js';
import { sourceTools } from './sources.js';

const REGISTRY_ORDER = [
  'web_search',
  'web_fetch',
  'image_search',
  'bash_tool',
  'create_file',
  'str_replace',
  'view',
  'present_files',
  'visualize_read_me',
  'visualize_show_widget',
  'ask_user_input_v0',
  'spawn_subagents',
  'list_sources',
  'search_sources',
  'read_source',
] as const;

/**
 * Every tool the agent can call, in CONTRACT.md's exact order.
 * Called per run so the registry always reflects current module state.
 */
export function buildToolRegistry(): ToolDef[] {
  const byName = new Map<string, ToolDef>();
  for (const def of [
    ...researchTools,
    ...workspaceTools,
    ...uxTools,
    ...subagentTools,
    ...sourceTools,
  ]) {
    byName.set(def.name, def);
  }

  const ordered: ToolDef[] = [];
  for (const name of REGISTRY_ORDER) {
    const def = byName.get(name);
    if (!def) throw new Error(`tool registry: missing tool "${name}"`);
    ordered.push(def);
    byName.delete(name);
  }
  // Nothing should be left over; if a module adds a tool, it still gets exposed.
  for (const def of byName.values()) ordered.push(def);

  return ordered;
}

export default buildToolRegistry;
