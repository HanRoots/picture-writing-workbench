import { useCallback, useEffect, useState } from 'react';
import Icon from './Icon.jsx';
import {
  AUTH_REQUIRED_EVENT,
  authenticate,
  hasStoredAccess,
  serviceStatus,
  validateStoredAccess,
} from '../lib/api.js';

export default function AccessGate({ children }) {
  const [state, setState] = useState({ view: 'loading', message: '' });

  const initialize = useCallback(async () => {
    setState({ view: 'loading', message: '' });
    try {
      const status = await serviceStatus();
      if (!status.authRequired) {
        setState({ view: 'ready', message: '' });
        return;
      }
      if (hasStoredAccess()) {
        try {
          await validateStoredAccess();
          setState({ view: 'ready', message: '' });
          return;
        } catch (error) {
          if (error.status !== 401) throw error;
        }
      }
      setState({ view: 'login', message: '' });
    } catch (error) {
      if (import.meta.env.DEV && !error.status) {
        setState({ view: 'ready', message: '' });
        return;
      }
      setState({ view: 'unavailable', message: error.message || '云端服务暂时无法连接' });
    }
  }, []);

  useEffect(() => {
    initialize();
    const requireAccess = () => setState({ view: 'login', message: '访问凭证已经失效，请重新输入。' });
    window.addEventListener(AUTH_REQUIRED_EVENT, requireAccess);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, requireAccess);
  }, [initialize]);

  if (state.view === 'ready') return children;
  if (state.view === 'loading') {
    return <div className="app-loading"><span className="large-spinner" /><p>正在连接看图写话服务…</p></div>;
  }
  if (state.view === 'unavailable') {
    return (
      <main className="access-page">
        <section className="access-card">
          <span className="access-icon error"><Icon name="alert" size={25} /></span>
          <p className="eyebrow">看图写话工作台</p>
          <h1>暂时无法连接服务</h1>
          <p>{state.message}</p>
          <button className="primary-button" onClick={initialize}><Icon name="refresh" size={17} /> 重新连接</button>
        </section>
      </main>
    );
  }
  return <LoginScreen message={state.message} onSuccess={() => setState({ view: 'ready', message: '' })} />;
}

function LoginScreen({ message, onSuccess }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState(message);
  const [submitting, setSubmitting] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (!password) {
      setError('请输入访问密码');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await authenticate(password);
      onSuccess();
    } catch (authError) {
      setError(authError.status === 401 ? '访问密码不正确' : (authError.message || '登录失败，请重试'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="access-page">
      <form className="access-card" onSubmit={submit}>
        <span className="access-icon"><Icon name="lock" size={24} /></span>
        <p className="eyebrow">独立项目 · 私密访问</p>
        <h1>看图写话工作台</h1>
        <p>请输入本项目专用访问密码。密码只保留在当前标签页，关闭后自动失效。</p>
        <label className="field-label access-password">
          <span>访问密码</span>
          <input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus />
        </label>
        {error && <div className="inline-alert error compact-alert"><Icon name="alert" size={16} /><span>{error}</span></div>}
        <button className="primary-button large" type="submit" disabled={submitting}>
          {submitting ? <><span className="spinner light" /> 正在验证</> : <>进入工作台 <Icon name="chevronRight" size={17} /></>}
        </button>
        <small>任务、图片和批改结果仍只保存在当前浏览器，不与其他项目共享。</small>
      </form>
    </main>
  );
}
