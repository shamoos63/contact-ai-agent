import { useState } from 'react';
import { Bot } from 'lucide-react';
import { api } from '../api.js';

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      await api('/login', { method: 'POST', body: { username, password } });
      onLogin();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="center">
      <form className="card login" onSubmit={submit}>
        <div className="login-head"><span className="brand-mark big"><Bot size={26} /></span><h1>Contact AI Agent</h1><p className="muted">Sign in to your dashboard</p></div>
        <label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
        <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <div className="error">{error}</div>}
        <button className="primary">Log in</button>
      </form>
    </div>
  );
}
