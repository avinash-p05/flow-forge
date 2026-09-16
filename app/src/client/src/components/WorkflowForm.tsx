import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Workflow, WorkflowInput } from '../types';

type WorkflowFormProps = {
  workflow?: Workflow;
  onSubmit: (input: WorkflowInput) => Promise<void>;
  onCancel: () => void;
};

const defaultSteps = JSON.stringify({
  steps: [{ name: 'First step', type: 'worker', config: { result: { completed: true } }, dependsOn: [] }],
}, null, 2);

export function WorkflowForm({ workflow, onSubmit, onCancel }: WorkflowFormProps) {
  const definition = workflow?.definition ? JSON.stringify(workflow.definition, null, 2) : defaultSteps;
  const [name, setName] = useState(workflow?.name ?? '');
  const [stepsJson, setStepsJson] = useState(definition);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFormError('');
    try {
      const parsed = JSON.parse(stepsJson) as { steps?: unknown };
      if (!Array.isArray(parsed.steps)) throw new Error('Definition must contain a steps array');
      setSaving(true);
      await onSubmit({ name, definition: { steps: parsed.steps as WorkflowInput['definition']['steps'] } });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Invalid workflow definition');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="form-panel">
      <div className="panel-heading"><div><h2>{workflow ? 'Edit workflow' : 'Create workflow'}</h2><p>Define steps as JSON. IDs are generated when omitted.</p></div></div>
      <form className="workflow-form" onSubmit={submit}>
        <label>Workflow name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer onboarding" required /></label>
        <label>Definition JSON<textarea value={stepsJson} onChange={(event) => setStepsJson(event.target.value)} rows={12} spellCheck={false} required /></label>
        {formError && <div className="form-error">{formError}</div>}
        <div className="form-actions"><button type="button" className="ghost-button" onClick={onCancel}>Cancel</button><button className="primary-button" disabled={saving}>{saving ? 'Saving…' : workflow ? 'Save changes' : 'Create workflow'}</button></div>
      </form>
    </div>
  );
}
