import type { Workflow } from '../types';

type DashboardProps = {
  email: string;
  workflows: Workflow[];
  notice: string;
  error: string;
  onLogout: () => void;
  onRefresh: () => void;
  onNotice: (message: string) => void;
  onClearNotice: () => void;
  onClearError: () => void;
  onCreate: () => void;
  onEdit: (workflow: Workflow) => void;
  onDelete: (workflow: Workflow) => void;
  onRun: (workflow: Workflow) => void;
};

function Stat({ label, value, detail, icon, positive = false }: { label: string; value: string; detail: string; icon: string; positive?: boolean }) {
  return <div className="stat-card"><div className={`stat-icon ${positive ? 'positive' : ''}`}>{icon}</div><p>{label}</p><strong>{value}</strong><small>{detail}</small></div>;
}

export function Dashboard({ email, workflows, notice, error, onLogout, onRefresh, onNotice, onClearNotice, onClearError, onCreate, onEdit, onDelete, onRun }: DashboardProps) {
  const stepCount = workflows.reduce((total, workflow) => total + (workflow.definition?.steps?.length ?? 0), 0);
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">✦</span><span>flowforge</span></div>
        <div className="workspace-label">WORKSPACE</div>
        <button className="workspace-switcher"><span className="workspace-icon">F</span><span>Personal workspace</span><span className="chevron">⌄</span></button>
        <nav><button className="nav-item active"><span>▦</span> Overview</button><button className="nav-item"><span>◇</span> Workflows <span className="nav-count">{workflows.length}</span></button><button className="nav-item"><span>◷</span> Executions</button></nav>
        <div className="sidebar-bottom"><div className="status-dot"><i /> API connected</div><button className="nav-item"><span>⚙</span> Settings</button><button className="user-row" onClick={onLogout}><span className="avatar">{email.charAt(0).toUpperCase() || 'U'}</span><span><b>{email || 'Your account'}</b><small>Sign out</small></span><span>⋮</span></button></div>
      </aside>
      <main className="content">
        <header className="topbar"><div><p className="eyebrow">WORKFLOW DASHBOARD</p><h1>Good evening<span className="accent">.</span></h1><p className="subtitle">Here’s what’s happening across your workflows.</p></div><button className="primary-button" onClick={onCreate}>＋ New workflow</button></header>
        {notice && <div className="notice">{notice}<button onClick={onClearNotice}>×</button></div>}
        {error && <div className="error-banner">{error}<button onClick={onClearError}>×</button></div>}
        <section className="stats-grid"><Stat label="Total workflows" value={workflows.length.toString()} detail="Your active automations" icon="◇" /><Stat label="Steps configured" value={stepCount.toString()} detail="Across all workflows" icon="⌘" /><Stat label="API status" value="Online" detail="All systems operational" icon="↗" positive /></section>
        <section className="panel workflow-panel"><div className="panel-heading"><div><h2>Your workflows</h2><p>Build, monitor, and manage your automations.</p></div><button className="ghost-button" onClick={onRefresh}>Refresh ↻</button></div>
          {workflows.length === 0 ? <div className="empty-state"><div className="empty-icon">✦</div><h3>Your workspace is ready</h3><p>Create your first workflow to start automating repetitive work.</p><button className="primary-button" onClick={onCreate}>Create your first workflow <span>→</span></button></div> : <div className="workflow-list">{workflows.map((workflow) => <div className="workflow-row" key={workflow.id}><div className="workflow-symbol">◇</div><div className="workflow-info"><b>{workflow.name}</b><span>{workflow.definition?.steps?.length ?? 0} steps · Updated recently</span></div><span className="pill">Ready</span><button className="row-action" onClick={() => onRun(workflow)}>Run</button><button className="row-action" onClick={() => onEdit(workflow)}>Edit</button><button className="row-action danger" onClick={() => onDelete(workflow)}>Delete</button></div>)}</div>}
        </section>
        <p className="footer-note">FlowForge <span>·</span> Reliable workflow orchestration, made simple.</p>
      </main>
    </div>
  );
}
