/**
 * Claude desktop extensions pass optional settings as "${user_config.x}" templates. If a
 * setting was left blank the literal template can come through, so treat that as unset.
 */
export const envValue = (v: string | undefined): string | undefined =>
  v && !v.trim().startsWith('${') ? v.trim() || undefined : undefined

export const truthy = (v: string | undefined) => ['1', 'true', 'yes', 'on'].includes((envValue(v) ?? '').toLowerCase())
