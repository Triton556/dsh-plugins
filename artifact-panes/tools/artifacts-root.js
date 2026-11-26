// Where one workspace's `artifacts/` physically lives.
//
// The logical address never changes: `artifacts/<project>/<topic>.html` stays
// the only path an artifact tool or a tab accepts. A workspace may declare an
// external physical root in `.dsh/artifact-panes.json`; without that
// declaration the folder must resolve inside the workspace, so a junction that
// points outside is refused exactly as before. The declaration is strict:
// a broken file is an error, never a silent fallback to `<cwd>/artifacts`.
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fail } from './contracts.js';

export const DECLARATION_RELATIVE_PATH = '.dsh/artifact-panes.json';
export const DECLARATION_FIELD = 'artifactsRoot';
// A declaration is one absolute path; anything larger is a mistake, not data.
export const DECLARATION_MAX_BYTES = 4096;

// Path containment on canonical (realpath) spellings. Windows paths compare
// case-insensitively through `path.relative`, POSIX paths do not.
export const within = (base, candidate) => {
  const relative = path.relative(base, candidate);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

// `path.isAbsolute('/archive')` is true on Windows but names no drive: it would
// depend on the process's current drive. A declaration must be fully qualified.
const isFullyQualified = value => process.platform === 'win32'
  ? /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value)
  : path.isAbsolute(value);

// The declared root string, or undefined when the workspace has no declaration.
// Present-but-invalid is always a failure: an operator who wrote the file must
// learn that it was not applied.
export async function readArtifactsRoot(workspaceRoot) {
  const file = path.join(workspaceRoot, DECLARATION_RELATIVE_PATH);
  let info;
  try {
    info = await fs.lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return undefined;
    fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration cannot be read');
  }
  if (!info.isFile() || info.isSymbolicLink()) fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration must be a regular file');
  if (info.size > DECLARATION_MAX_BYTES) fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration exceeds ' + DECLARATION_MAX_BYTES + ' bytes');
  let real;
  try {
    real = await fs.realpath(file);
  } catch (error) {
    fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration cannot be resolved');
  }
  // The declaration is read only from inside the workspace it configures.
  if (!within(workspaceRoot, real)) fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration escapes the workspace');
  let body;
  try {
    body = JSON.parse((await fs.readFile(real, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration is not valid JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration must be a JSON object');
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== DECLARATION_FIELD) fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration must contain only "' + DECLARATION_FIELD + '"');
  const value = body[DECLARATION_FIELD];
  if (typeof value !== 'string' || !value || value.length > DECLARATION_MAX_BYTES || !isFullyQualified(value)) {
    fail('ARTIFACTS_ROOT_INVALID', 'Artifacts root declaration must be a fully qualified absolute path');
  }
  return value;
}

// The physical scope of `artifacts/` for one workspace, resolved on every call:
//   { root }    canonical workspace path (`session.header.cwd` equivalent);
//   { base }    canonical physical folder the logical `artifacts/` stands for;
//   { declared} whether the folder came from the workspace declaration.
export async function artifactsScope(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) fail('CALLER_UNAVAILABLE', 'Caller workspace is unavailable');
  let root;
  try {
    root = await fs.realpath(cwd);
  } catch (error) {
    fail('CALLER_UNAVAILABLE', 'Caller workspace is unavailable');
  }
  const declared = await readArtifactsRoot(root);
  if (declared === undefined) {
    const base = await fs.realpath(path.join(root, 'artifacts'));
    if (!within(root, base)) fail('PATH_OUT_OF_SCOPE', 'Artifacts root escapes workspace');
    const info = await fs.stat(base);
    // A regular file named `artifacts` is not a folder to serve.
    if (!info.isDirectory()) fail('PATH_OUT_OF_SCOPE', 'Artifacts root is not a directory');
    return { root, base, declared: false };
  }
  let base;
  try {
    base = await fs.realpath(declared);
  } catch (error) {
    fail('ARTIFACTS_ROOT_INVALID', 'Declared artifacts root does not exist');
  }
  let info;
  try {
    info = await fs.stat(base);
  } catch (error) {
    fail('ARTIFACTS_ROOT_INVALID', 'Declared artifacts root does not exist');
  }
  if (!info.isDirectory()) fail('ARTIFACTS_ROOT_INVALID', 'Declared artifacts root is not a directory');
  return { root, base, declared: true };
}

// Logical `artifacts/...` address to the physical path it names.
export function physicalArtifact(scope, logical) {
  const segments = String(logical).split('/');
  return scope.declared ? path.join(scope.base, ...segments.slice(1)) : path.join(scope.root, ...segments);
}

// Physical path back to the one logical address the client already uses, or
// undefined when the path is not inside the physical artifacts folder.
export function logicalArtifact(scope, physical) {
  if (!within(scope.base, physical)) return undefined;
  const relative = path.relative(scope.base, physical).split(path.sep).join('/');
  return relative ? 'artifacts/' + relative : 'artifacts';
}
