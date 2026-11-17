/** Shared Compose defaults; credentials remain generated in a private external directory. */
import { realpathSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
// Resolve existing ancestors too, so a not-yet-created directory cannot hide under a symlink.
function canonicalPath(path) {
  let current = resolve(path);
  const suffix = [];
  for (;;) {
    try { return resolve(realpathSync(current), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Cannot resolve a dangling secrets symlink');
      } catch (statError) { if (statError.code !== 'ENOENT') throw statError; }
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current)); current = parent;
    }
  }
}
function insideContext(root, path) {
  const nested = relative(root, path);
  return !nested || (!isAbsolute(nested) && nested !== '..' && !nested.startsWith(`..${sep}`));
}
export function installationEnv(input = process.env) {
  const project = input.SELF_HOST_PROJECT ?? 'borecount-selfhost-01';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid SELF_HOST_PROJECT');
  const requested = resolve(input.SELF_HOST_SECRETS_DIR ?? join(homedir(), '.local/share', project));
  const directory = canonicalPath(requested);
  if (insideContext(exampleRoot, requested) || insideContext(realpathSync(exampleRoot), directory)) {
    throw new Error('Keep secrets outside the example build context, including through symlinks');
  }
  const port = input.SELF_HOST_PORT ?? '8082';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid SELF_HOST_PORT');
  return { ...input, SELF_HOST_PROJECT: project, SELF_HOST_SECRETS_DIR: directory, SELF_HOST_PORT: port,
    SELF_HOST_UID: input.SELF_HOST_UID ?? String(process.getuid?.() ?? 1000),
    SELF_HOST_GID: input.SELF_HOST_GID ?? String(process.getgid?.() ?? 1000) };
}
