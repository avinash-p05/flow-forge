export type CacheConfig = {
  workflowDefinitionTtlSeconds: number;
};

const positiveInteger = (name: string, value: string | undefined, fallback: string): number => {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
};

export const getCacheConfig = (): CacheConfig => ({
  workflowDefinitionTtlSeconds: positiveInteger(
    'WORKFLOW_CACHE_TTL_SECONDS',
    process.env.WORKFLOW_CACHE_TTL_SECONDS,
    '300',
  ),
});
