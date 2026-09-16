import type { FormEvent } from 'react';
import type { AuthMode } from '../types';

type AuthScreenProps = {
  mode: AuthMode;
  email: string;
  password: string;
  error: string;
  loading: boolean;
  onModeChange: (mode: AuthMode) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: (event: FormEvent) => void;
};

export function AuthScreen({
  mode,
  email,
  password,
  error,
  loading,
  onModeChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: AuthScreenProps) {
  return (
    <div className="auth-layout">
      <div className="auth-visual">
        <div className="brand"><span className="brand-mark">✦</span><span>flowforge</span></div>
        <div className="visual-copy">
          <p className="eyebrow">WORKFLOW ORCHESTRATION</p>
          <h1>Make work<br /><em>flow.</em></h1>
          <p>Design reliable automations, execute with confidence, and keep your team moving forward.</p>
        </div>
        <div className="orbit orbit-one" />
        <div className="orbit orbit-two" />
        <span className="visual-spark">✦</span>
      </div>
      <div className="auth-card">
        <div className="auth-inner">
          <p className="eyebrow">WELCOME TO FLOWFORGE</p>
          <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="auth-subtitle">
            {mode === 'login' ? 'Sign in to access your workspace.' : 'Start building better workflows today.'}
          </p>
          <form onSubmit={onSubmit}>
            <label>
              Email address
              <input type="email" value={email} onChange={(event) => onEmailChange(event.target.value)} placeholder="you@company.com" required />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => onPasswordChange(event.target.value)} placeholder="At least 8 characters" minLength={8} required />
            </label>
            {error && <div className="form-error">{error}</div>}
            <button className="primary-button full-width" disabled={loading}>
              {loading ? 'Please wait…' : mode === 'login' ? 'Sign in →' : 'Create account →'}
            </button>
          </form>
          <p className="switch-auth">
            {mode === 'login' ? 'New to FlowForge?' : 'Already have an account?'}{' '}
            <button type="button" onClick={() => onModeChange(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </p>
        </div>
        <p className="legal">By continuing, you agree to our Terms and Privacy Policy.</p>
      </div>
    </div>
  );
}
