/**
 * Locates the immutable migration chain shipped with this PostgreSQL adapter.
 * Hosts pass this directory to their controlled Drizzle migration step, using a
 * separate migration login and journal. Importing this module performs no DDL.
 */
import { fileURLToPath } from 'node:url';

export const borecountMigrationsPath = fileURLToPath(new URL('./migrations/', import.meta.url));
