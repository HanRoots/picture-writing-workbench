import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AccessGate from './components/AccessGate.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AccessGate><App /></AccessGate>
  </React.StrictMode>,
);
