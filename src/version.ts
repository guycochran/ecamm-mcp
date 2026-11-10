import { createRequire } from 'node:module'

/** Single source of truth: package.json, which sits one level above dist/ in every install. */
export const VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
