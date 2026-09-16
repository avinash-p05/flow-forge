import type { AuditEvent, JobExecution, Workflow, WorkflowExecution } from '../types';

type ExecutionPanelProps = {
  workflow: Workflow;
  execution: WorkflowExecution | null;
  jobs: JobExecution[];
  running: boolean;
  onRun: () => void;
  onCancel: () => void;
  onClose: () => void;
  history: AuditEvent[];
};

export function ExecutionPanel({ workflow, execution, jobs, running, onRun, onCancel, onClose, history }: ExecutionPanelProps) {
  return (
    <div className="execution-panel">
      <div className="panel-heading"><div><h2>Run workflow</h2><p>{workflow.name}</p></div><div className="form-actions"><button className="ghost-button" onClick={onClose}>Close</button><button className="primary-button" onClick={onRun} disabled={running}>{running ? 'Running…' : '▶ Run now'}</button></div></div>
      {execution && <div className="execution-summary"><strong>{execution.status}</strong><span>{execution.id}</span>{['QUEUED', 'RUNNING', 'RETRYING'].includes(execution.status) && <button className="ghost-button" onClick={onCancel}>Cancel</button>}</div>}
      {jobs.length > 0 && <div className="job-list">{jobs.map((job) => <div className="job-row" key={job.id}><span>{job.stepName}</span><small>{job.stepType} · {job.status} · attempts {job.attempts}</small>{job.error && <em>{job.error}</em>}</div>)}</div>}
      {history.length > 0 && <div className="job-list"><h3>Execution history</h3>{history.map((event) => <div className="job-row" key={event.id}><span>{event.event_type}</span><small>{new Date(event.created_at).toLocaleString()}</small></div>)}</div>}
    </div>
  );
}
