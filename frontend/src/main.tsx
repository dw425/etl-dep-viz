import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { installGlobalErrorHandler } from './api/client';
import './index.css';

installGlobalErrorHandler();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
