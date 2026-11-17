/** Shared Compose defaults; credentials remain generated in a private external directory. */
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
export const exampleRoot = fileURLToPath(new URL('..', import.meta.url));
export function installationEnv(input = process.env) {
  const project = input.SELF_HOST_PROJECT ?? 'borecount-selfhost-01';
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) throw new Error('Invalid SELF_HOST_PROJECT');
  const directory = resolve(input.SELF_HOST_SECRETS_DIR ?? join(homedir(), '.local/share', project));
  const inside = relative(exampleRoot, directory);
  if (!inside || (!isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`))) throw new Error('Keep secrets outside the example build context');
  const port = input.SELF_HOST_PORT ?? '8082';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid SELF_HOST_PORT');
  return { ...input, SELF_HOST_PROJECT: project, SELF_HOST_SECRETS_DIR: directory, SELF_HOST_PORT: port,
    SELF_HOST_UID: input.SELF_HOST_UID ?? String(process.getuid?.() ?? 1000),
    SELF_HOST_GID: input.SELF_HOST_GID ?? String(process.getgid?.() ?? 1000) };
}
