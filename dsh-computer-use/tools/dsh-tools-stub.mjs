// Stand-in for @deepseek-ai/dsh-tools when verifying the plugin outside the
// host. Mirrors the real contract: defineTool(definition) returns a definition
// whose shape the host would register.
export function defineTool(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('defineTool: definition required');
  if (typeof definition.name !== 'string' || !definition.name) throw new Error('defineTool: name required');
  if (typeof definition.description !== 'string' || !definition.description) throw new Error('defineTool: description required');
  if (typeof definition.execute !== 'function') throw new Error('defineTool: execute required');
  return { ...definition, __stub: true };
}

export const __stub = true;