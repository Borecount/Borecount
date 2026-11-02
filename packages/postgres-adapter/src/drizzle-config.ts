import { fileURLToPath } from 'node:url';

export const borecountDrizzleSchemaPath = fileURLToPath(new URL('./schema.js', import.meta.url));
