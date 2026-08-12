import { getCacheConfig } from '../config/cache.config.js';
import { ensureRedisConnection } from '../infrastructure/redis.client.js';
import type { WorkflowDefinition } from '../types/workflow.types.js';

const config = getCacheConfig();

const cacheKey = (workflowId: string, userId: string): string =>
  `flowforge:workflow-definition:${userId}:${workflowId}`;

export const getCachedWorkflowDefinition = async (
  workflowId: string,
  userId: string,
): Promise<WorkflowDefinition | null> => {
  try {
    const client = await ensureRedisConnection();
    if (!client) return null;
    const value = await client.get(cacheKey(workflowId, userId));
    return value ? JSON.parse(value) as WorkflowDefinition : null;
  } catch (error) {
    console.error('Workflow cache read failed', error);
    return null;
  }
};

export const cacheWorkflowDefinition = async (
  workflowId: string,
  userId: string,
  definition: WorkflowDefinition,
): Promise<void> => {
  try {
    const client = await ensureRedisConnection();
    if (client) {
      await client.setex(
        cacheKey(workflowId, userId),
        config.workflowDefinitionTtlSeconds,
        JSON.stringify(definition),
      );
    }
  } catch (error) {
    console.error('Workflow cache write failed', error);
  }
};

export const invalidateWorkflowDefinition = async (
  workflowId: string,
  userId: string,
): Promise<void> => {
  try {
    const client = await ensureRedisConnection();
    if (client) await client.del(cacheKey(workflowId, userId));
  } catch (error) {
    console.error('Workflow cache invalidation failed', error);
  }
};
