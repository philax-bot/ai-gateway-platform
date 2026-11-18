import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyUiDesign, readUiDesign } from './ui-mode';
import './styles.css';
import './design-v2.css';
import './design-v3.css';
import './design-v4.css';
import './design-v5.css';
import './analytics.css';
import './cockpit-demo.css';
import './workflow.css';
import './model-discovery.css';
import './model-surface.css';
import './provider-picker.css';
import './person-picker.css';

applyUiDesign(readUiDesign());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
