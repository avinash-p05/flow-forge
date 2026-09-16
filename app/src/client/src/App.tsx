import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { AuthScreen } from './components/AuthScreen';
import { Dashboard } from './components/Dashboard';
import { ExecutionPanel } from './components/ExecutionPanel';
import { WorkflowForm } from './components/WorkflowForm';
import { api } from './lib/api';
import type { AuditEvent, AuthMode, AuthResponse, JobExecution, Workflow, WorkflowExecution, WorkflowInput } from './types';

function App() {
  const [token, setToken] = useState(() => localStorage.getItem('flowforge_access'));
  const [refreshToken, setRefreshToken] = useState(() => localStorage.getItem('flowforge_refresh'));
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<'create' | Workflow | null>(null);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [execution, setExecution] = useState<WorkflowExecution | null>(null);
  const [jobs, setJobs] = useState<JobExecution[]>([]);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<AuditEvent[]>([]);

  const loadWorkflows = async (accessToken: string) => {
    try {
      setWorkflows(await api<Workflow[]>('/api/v1/workflows', {}, accessToken));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load workflows');
    }
  };

  useEffect(() => {
    if (token) void loadWorkflows(token);
  }, [token]);

  useEffect(() => {
    if (!token || !execution || ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(execution.status)) return;
    const timer = window.setInterval(() => {
      void Promise.all([
        api<WorkflowExecution>(`/api/v1/executions/${execution.id}`, {}, token),
        api<JobExecution[]>(`/api/v1/executions/${execution.id}/jobs`, {}, token),
        api<AuditEvent[]>(`/api/v1/executions/${execution.id}/history`, {}, token),
      ]).then(([current, currentJobs, currentHistory]) => {
        setExecution(current);
        setJobs(currentJobs);
        setHistory(currentHistory);
      }).catch(() => undefined);
    }, 1500);
    return () => window.clearInterval(timer);
  }, [execution, token]);

  const submitAuth = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      const result = await api<AuthResponse>(`/api/v1/auth/${authMode}`, {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      localStorage.setItem('flowforge_access', result.token);
      localStorage.setItem('flowforge_refresh', result.refreshToken);
      setToken(result.token);
      setRefreshToken(result.refreshToken);
      setEmail(result.user?.email ?? email);
      setNotice(authMode === 'register' ? 'Account created. Welcome to FlowForge.' : 'Welcome back.');
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const logout = async () => {
    if (refreshToken) await api('/api/v1/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }).catch(() => undefined);
    localStorage.removeItem('flowforge_access');
    localStorage.removeItem('flowforge_refresh');
    setToken(null);
    setRefreshToken(null);
    setWorkflows([]);
  };

  const saveWorkflow = async (input: WorkflowInput) => {
    const editing = editor !== 'create' && editor;
    const path = editing ? `/api/v1/workflows/${editing.id}` : '/api/v1/workflows';
    const saved = await api<Workflow>(path, { method: editing ? 'PUT' : 'POST', body: JSON.stringify(input) }, token!);
    await loadWorkflows(token!);
    setEditor(null);
    setNotice(editing ? 'Workflow updated.' : 'Workflow created.');
    setSelectedWorkflow(saved);
  };

  const deleteWorkflow = async (workflow: Workflow) => {
    if (!window.confirm(`Delete "${workflow.name}"?`)) return;
    await api(`/api/v1/workflows/${workflow.id}`, { method: 'DELETE' }, token!);
    await loadWorkflows(token!);
    if (selectedWorkflow?.id === workflow.id) setSelectedWorkflow(null);
    setNotice('Workflow deleted.');
  };

  const runWorkflow = async (workflow: Workflow) => {
    setSelectedWorkflow(workflow);
    setRunning(true);
    setError('');
    try {
      const result = await api<WorkflowExecution>(`/api/v1/workflows/${workflow.id}/executions`, {
        method: 'POST',
        headers: { 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ input: {} }),
      }, token!);
      setExecution(result);
      setJobs(await api<JobExecution[]>(`/api/v1/executions/${result.id}/jobs`, {}, token!));
      setHistory(await api<AuditEvent[]>(`/api/v1/executions/${result.id}/history`, {}, token!));
      setNotice('Workflow execution queued.');
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : 'Unable to run workflow');
    } finally {
      setRunning(false);
    }
  };

  const cancelExecution = async () => {
    if (!execution) return;
    await api(`/api/v1/executions/${execution.id}/cancel`, { method: 'POST' }, token!);
    setExecution({ ...execution, status: 'CANCELLED' });
    setNotice('Execution cancelled.');
  };

  if (!token) {
    return <AuthScreen mode={authMode} email={email} password={password} error={error} loading={loading} onModeChange={setAuthMode} onEmailChange={setEmail} onPasswordChange={setPassword} onSubmit={submitAuth} />;
  }

  return (
    <>
      <Dashboard email={email} workflows={workflows} notice={notice} error={error} onLogout={logout} onRefresh={() => void loadWorkflows(token)} onNotice={setNotice} onClearNotice={() => setNotice('')} onClearError={() => setError('')} onCreate={() => setEditor('create')} onEdit={setEditor} onDelete={(workflow) => void deleteWorkflow(workflow)} onRun={(workflow) => void runWorkflow(workflow)} />
      {editor && <div className="modal-backdrop"><WorkflowForm workflow={editor === 'create' ? undefined : editor} onSubmit={saveWorkflow} onCancel={() => setEditor(null)} /></div>}
      {selectedWorkflow && <div className="modal-backdrop"><ExecutionPanel workflow={selectedWorkflow} execution={execution} jobs={jobs} history={history} running={running} onRun={() => void runWorkflow(selectedWorkflow)} onCancel={() => void cancelExecution()} onClose={() => { setSelectedWorkflow(null); setExecution(null); setJobs([]); setHistory([]); }} /></div>}
    </>
  );
}

export default App;
