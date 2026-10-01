import { createRoot } from 'react-dom/client';
import App from './App';
import { PanelWindow } from './windows/PanelWindow';

const isPanel = window.location.hash === '#panel';

createRoot(document.getElementById('root')!).render(isPanel ? <PanelWindow /> : <App />);
