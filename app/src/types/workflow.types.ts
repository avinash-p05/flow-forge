export type WorkflowStep = {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  dependsOn: string[];
};

export type WorkflowDefinition = {
  steps: WorkflowStep[];
};

export type Workflow = {
  id: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  createdAt: string;
  updatedAt: string;
};
