// bash_tool, create_file, str_replace, view, present_files — CONTRACT.md tools 4–8,
// plus the "Asset protocol" interception on create_file/str_replace for assets/*.html.
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { addAssetVersion, createAsset, findAssetByPath } from '../repo.js';
import type { ToolCtx, ToolDef } from '../types.js';

const BASH_TIMEOUT_MS = 60_000;
const OUTPUT_CAP = 50_000;
/** Per-stream accumulation ceiling; the combined output is still capped at OUTPUT_CAP. */
const BUFFER_CAP = 1_000_000;
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|ico|svg|tiff?|avif|heic)$/i;
const ASSET_PATH_RE = /^assets\/[^/]+\.html$/i;

// ---------------------------------------------------------------------------
// path resolution — confined to workspaceDir, reject `..` escapes
// ---------------------------------------------------------------------------

interface ResolvedPath {
  abs: string;
  /** normalized, forward-slash relative path from workspaceDir (used for asset matching) */
  rel: string;
}

function resolveInWorkspace(workspaceDir: string, relPath: string): ResolvedPath | { error: string } {
  const raw = relPath ?? '';
  const workspaceAbs = path.resolve(workspaceDir);
  const candidate = path.isAbsolute(raw) ? raw : path.join(workspaceAbs, raw);
  const abs = path.resolve(candidate);
  if (abs !== workspaceAbs && !abs.startsWith(workspaceAbs + path.sep)) {
    return { error: `ERROR: path escapes workspace directory: ${relPath}` };
  }
  const rel = path.relative(workspaceAbs, abs).split(path.sep).join('/');
  return { abs, rel };
}

function isAssetPath(rel: string): boolean {
  return ASSET_PATH_RE.test(rel);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = m?.[1]?.trim();
  return title ? title : undefined;
}

function slugFromRelPath(rel: string): string {
  return path.basename(rel).replace(/\.html$/i, '');
}

/** Register/version an asset for a create_file or str_replace write, emitting the right event. */
function interceptAssetWrite(ctx: ToolCtx, rel: string, html: string): void {
  const existing = findAssetByPath(ctx.chatId, rel);
  if (existing) {
    const asset = addAssetVersion(existing.id, html);
    ctx.emit('asset.version', { assetId: asset.id, version: asset.latestVersion });
  } else {
    const title = extractTitle(html) ?? slugFromRelPath(rel);
    const asset = createAsset({
      chatId: ctx.chatId,
      messageId: ctx.messageId,
      title,
      relPath: rel,
      html,
    });
    ctx.emit('asset.created', { asset, version: 1 });
  }
}

// ---------------------------------------------------------------------------
// bash_tool
// ---------------------------------------------------------------------------

function runBash(command: string, cwd: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve('[process terminated: run stopped before start]');
      return;
    }
    // detached: the shell leads its own process group, so a timeout or a
    // stopped run kills the whole group (negative pid) — pipelines and
    // backgrounded children would otherwise outlive the shell.
    const child = spawn(command, {
      cwd,
      shell: '/bin/bash',
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const killGroup = () => {
      if (child.pid == null) return;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // process group already gone
      }
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n' : '') + stderr;
      if (timedOut) out += `${out ? '\n' : ''}[process terminated: SIGKILL — timed out after 60s]`;
      else if (aborted) out += `${out ? '\n' : ''}[process terminated: SIGKILL — run stopped]`;
      if (out.length > OUTPUT_CAP) {
        out = out.slice(0, OUTPUT_CAP) + '\n[...output truncated at 50000 chars...]';
      }
      resolve(out || '(no output)');
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, BASH_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      killGroup();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < BUFFER_CAP) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < BUFFER_CAP) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      if (!stdout && !stderr) stderr = err.message;
      finish();
    });
    child.on('close', finish);
  });
}

const bash_tool: ToolDef = {
  name: 'bash_tool',
  description:
    'Execute a shell command in the chat workspace directory. 60s timeout; stdout+stderr combined and capped at 50k chars.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to run.' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    try {
      const command = typeof args?.command === 'string' ? args.command : '';
      if (!command.trim()) return 'ERROR: command must be a non-empty string';
      return await runBash(command, ctx.workspaceDir, ctx.signal);
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

// ---------------------------------------------------------------------------
// create_file
// ---------------------------------------------------------------------------

const create_file: ToolDef = {
  name: 'create_file',
  description:
    'Create (or overwrite) a file at path within the workspace, writing content. Writing to assets/<slug>.html registers/updates a rendered asset.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace.' },
      content: { type: 'string', description: 'Full file contents.' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    try {
      const rawPath = args?.path;
      const content = args?.content;
      if (typeof rawPath !== 'string' || !rawPath) return 'ERROR: path must be a non-empty string';
      if (typeof content !== 'string') return 'ERROR: content must be a string';

      const resolved = resolveInWorkspace(ctx.workspaceDir, rawPath);
      if ('error' in resolved) return resolved.error;

      mkdirSync(path.dirname(resolved.abs), { recursive: true });
      writeFileSync(resolved.abs, content, 'utf8');

      if (isAssetPath(resolved.rel)) {
        interceptAssetWrite(ctx, resolved.rel, content);
        return `Created ${resolved.rel} (${content.length} bytes) — registered as asset.`;
      }
      return `Created ${resolved.rel} (${content.length} bytes).`;
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

// ---------------------------------------------------------------------------
// str_replace
// ---------------------------------------------------------------------------

const str_replace: ToolDef = {
  name: 'str_replace',
  description:
    'Replace an exact, unique occurrence of old_str with new_str in the file at path. Fails unless old_str matches exactly once.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace.' },
      old_str: { type: 'string', description: 'Exact text to find; must occur exactly once.' },
      new_str: { type: 'string', description: 'Replacement text.' },
    },
    required: ['path', 'old_str', 'new_str'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    try {
      const rawPath = args?.path;
      const oldStr = args?.old_str;
      const newStr = args?.new_str;
      if (typeof rawPath !== 'string' || !rawPath) return 'ERROR: path must be a non-empty string';
      if (typeof oldStr !== 'string' || oldStr.length === 0) return 'ERROR: old_str must be a non-empty string';
      if (typeof newStr !== 'string') return 'ERROR: new_str must be a string';

      const resolved = resolveInWorkspace(ctx.workspaceDir, rawPath);
      if ('error' in resolved) return resolved.error;
      if (!existsSync(resolved.abs) || !statSync(resolved.abs).isFile()) {
        return `ERROR: file not found: ${resolved.rel}`;
      }

      const original = readFileSync(resolved.abs, 'utf8');
      const occurrences = original.split(oldStr).length - 1;
      if (occurrences === 0) return `ERROR: old_str not found in ${resolved.rel}`;
      if (occurrences > 1) return `ERROR: old_str matches ${occurrences} times in ${resolved.rel}; must match exactly once`;

      const idx = original.indexOf(oldStr);
      const updated = original.slice(0, idx) + newStr + original.slice(idx + oldStr.length);
      writeFileSync(resolved.abs, updated, 'utf8');

      if (isAssetPath(resolved.rel)) {
        interceptAssetWrite(ctx, resolved.rel, updated);
        return `Updated ${resolved.rel} — asset version bumped.`;
      }
      return `Replaced 1 occurrence in ${resolved.rel}.`;
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

const view: ToolDef = {
  name: 'view',
  description:
    'View a file (optionally a line range, with line numbers) or list a directory within the workspace. Images return a binary placeholder.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative path within the workspace ("." for root).' },
      start_line: { type: 'number', description: '1-indexed first line to show (inclusive).' },
      end_line: { type: 'number', description: '1-indexed last line to show (inclusive).' },
    },
    required: ['path'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    try {
      const rawPath = typeof args?.path === 'string' && args.path.length > 0 ? args.path : '.';
      const resolved = resolveInWorkspace(ctx.workspaceDir, rawPath);
      if ('error' in resolved) return resolved.error;
      if (!existsSync(resolved.abs)) return `ERROR: path not found: ${resolved.rel || '.'}`;

      const stat = statSync(resolved.abs);

      if (stat.isDirectory()) {
        const entries = readdirSync(resolved.abs, { withFileTypes: true })
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort((a, b) => a.localeCompare(b));
        const label = resolved.rel || '.';
        if (entries.length === 0) return `${label} (empty directory)`;
        return `${label}:\n${entries.join('\n')}`;
      }

      if (IMAGE_EXT_RE.test(resolved.abs)) {
        return `[binary image: ${resolved.rel}]`;
      }

      const content = readFileSync(resolved.abs, 'utf8');
      const lines = content.split('\n');
      const startLine =
        typeof args?.start_line === 'number' && args.start_line > 0 ? Math.floor(args.start_line) : 1;
      const endLine =
        typeof args?.end_line === 'number' && args.end_line > 0 ? Math.floor(args.end_line) : lines.length;
      if (startLine > endLine) return `ERROR: start_line (${startLine}) must be <= end_line (${endLine})`;

      const sliceStart = Math.max(0, startLine - 1);
      const sliceEnd = Math.min(lines.length, endLine);
      const numbered = lines
        .slice(sliceStart, sliceEnd)
        .map((line, i) => `${String(sliceStart + i + 1).padStart(5, ' ')}\t${line}`);
      return numbered.join('\n');
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

// ---------------------------------------------------------------------------
// present_files
// ---------------------------------------------------------------------------

const present_files: ToolDef = {
  name: 'present_files',
  description: 'Present one or more workspace files to the user as downloadable file cards in the chat.',
  parameters: {
    type: 'object',
    properties: {
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Relative paths within the workspace to present.',
      },
      title: { type: 'string', description: 'Optional label for the presented file group.' },
    },
    required: ['paths'],
    additionalProperties: false,
  },
  async execute(args: any, ctx: ToolCtx): Promise<string> {
    try {
      const paths = args?.paths;
      if (!Array.isArray(paths) || paths.length === 0) return 'ERROR: paths must be a non-empty array of strings';

      const files: { name: string; relPath: string; size: number }[] = [];
      for (const p of paths) {
        if (typeof p !== 'string' || !p) return `ERROR: invalid path in paths: ${JSON.stringify(p)}`;
        const resolved = resolveInWorkspace(ctx.workspaceDir, p);
        if ('error' in resolved) return resolved.error;
        if (!existsSync(resolved.abs) || !statSync(resolved.abs).isFile()) {
          return `ERROR: file not found: ${resolved.rel}`;
        }
        const size = statSync(resolved.abs).size;
        files.push({ name: path.basename(resolved.abs), relPath: resolved.rel, size });
      }

      ctx.emit('files.presented', { messageId: ctx.messageId, files });
      return `Presented ${files.length} file(s): ${files.map((f) => f.name).join(', ')}`;
    } catch (err: any) {
      return `ERROR: ${err?.message ?? String(err)}`;
    }
  },
};

export const workspaceTools: ToolDef[] = [bash_tool, create_file, str_replace, view, present_files];
