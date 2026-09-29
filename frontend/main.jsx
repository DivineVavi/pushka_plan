import { createRoot } from 'react-dom/client';
import { MaxUI } from '@maxhub/max-ui';
import '@maxhub/max-ui/styles.css';
import './style.css';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <MaxUI className="app-shell">
    <App />
  </MaxUI>,
);
