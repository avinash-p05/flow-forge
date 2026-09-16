export type AuthMode = 'login' | 'register';

export type Workflow = {
  id: string;
  name: string;
  definition?: { steps?: WorkflowStep[] };
  createdAt?: string;
  updatedAt?: string;
};

export type WorkflowStep = {
  id?: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  dependsOn?: string[];
};

export type WorkflowInput = {
  name: string;
  definition: { steps: WorkflowStep[] };
};

export type WorkflowExecution = {
  id: string;
  workflowId: string;
  status: string;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
  output: Record<string, unknown> | null;
};

export type JobExecution = {
  id: string;
  stepId: string;
  stepName: string;
  stepType: string;
  status: string;
  attempts: number;
  error: string | null;
  output: Record<string, unknown> | null;
};

export type AuditEvent = {
  id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export type AuthResponse = {
  token: string;
  refreshToken: string;
  user?: { email: string };
};
