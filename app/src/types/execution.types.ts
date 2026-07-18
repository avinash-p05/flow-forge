export const executionStatuses = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'RETRYING',
  'CANCELLED',
  'BLOCKED',
] as const;

export type ExecutionStatus = (typeof executionStatuses)[number];
export type JobStatus = Exclude<ExecutionStatus, 'PENDING' | 'QUEUED' | 'RETRYING'> | 'PENDING' | 'RETRYING' | 'SKIPPED';

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: ExecutionStatus;
  idempotencyKey: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
};

export type JobExecution = {
  id: string;
  executionId: string;
  stepId: string;
  stepName: string;
  stepType: string;
  stepConfig: Record<string, unknown>;
  stepOrder: number;
  status: JobStatus;
  attempts: number;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  errorCode?: string | null;
};
