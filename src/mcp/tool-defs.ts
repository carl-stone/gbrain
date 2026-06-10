import type { Operation, ParamDef } from '../core/operations.ts';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
  /**
   * Broad result schema. Individual operation payloads are JSON-stringified in
   * MCP `content` today; this schema gives ChatGPT a declared output contract
   * without falsely narrowing heterogeneous operation results.
   */
  outputSchema: Record<string, unknown>;
  /**
   * MCP / ChatGPT tool-planning hints. These are advisory only: authorization
   * and mutation policy are still enforced server-side in operation dispatch.
   */
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    openWorldHint: boolean;
    idempotentHint?: boolean;
  };
  /** OAuth scope required for this tool, mirrored in _meta for older clients. */
  securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>;
  _meta: {
    securitySchemes: Array<{ type: 'oauth2'; scopes: string[] }>;
    'openai/toolInvocation/invoking': string;
    'openai/toolInvocation/invoked': string;
  };
}

/**
 * Convert a single ParamDef to a JSON Schema fragment. Recursive on `items`.
 *
 * Single source of truth for ParamDef→JSON Schema mapping. Consumed by:
 * - buildToolDefs (stdio MCP server.ts via tool-defs.ts)
 * - serve-http.ts tools/list handler (HTTP MCP path)
 * - brain-allowlist.ts paramsToInputSchema (subagent tool registry)
 *
 * The three call sites previously each had their own inline destructure that
 * drifted from each other (live HTTP MCP path dropped `items` entirely in
 * v0.32 PR review). Centralizing here closes the bug class at the
 * architecture level instead of patching one site at a time.
 *
 * Key ordering (type, description, enum, default, items) is intentional —
 * matches the pre-v0.34 inline mappers so JSON.stringify output stays
 * byte-stable for the byte-equality regression test.
 */
export function paramDefToSchema(p: ParamDef): Record<string, unknown> {
  return {
    type: p.type === 'array' ? 'array' : p.type,
    ...(p.description ? { description: p.description } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.items ? { items: paramDefToSchema(p.items) } : {}),
  };
}

const DEFAULT_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

const DESTRUCTIVE_OPERATION_NAMES = new Set([
  'delete_page',
  'purge_deleted_pages',
  'remove_link',
  'remove_tag',
  'forget_fact',
  'revert_version',
  'restore_page',
  'schema_apply_mutations',
]);

function requiredScope(op: Operation): string {
  return op.scope ?? 'read';
}

function toolAnnotations(op: Operation): McpToolDef['annotations'] {
  const readOnly = op.mutating !== true;
  return {
    readOnlyHint: readOnly,
    destructiveHint: DESTRUCTIVE_OPERATION_NAMES.has(op.name),
    // GBrain tools operate inside the authenticated user's brain/account. Even
    // mutating tools are not open-world publication unless a future operation
    // explicitly declares that behavior.
    openWorldHint: false,
    ...(readOnly ? { idempotentHint: true } : {}),
  };
}

function invocationText(op: Operation, phase: 'invoking' | 'invoked'): string {
  const verb = phase === 'invoking' ? 'Running' : 'Done';
  const text = `${verb} ${op.name}`;
  return text.length <= 64 ? text : text.slice(0, 64);
}

export function buildToolDefs(ops: Operation[]): McpToolDef[] {
  return ops.map(op => {
    const securitySchemes = [{ type: 'oauth2' as const, scopes: [requiredScope(op)] }];
    return {
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, paramDefToSchema(v)]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
      outputSchema: op.outputSchema ?? DEFAULT_OUTPUT_SCHEMA,
      annotations: toolAnnotations(op),
      securitySchemes,
      _meta: {
        securitySchemes,
        'openai/toolInvocation/invoking': invocationText(op, 'invoking'),
        'openai/toolInvocation/invoked': invocationText(op, 'invoked'),
      },
    };
  });
}
