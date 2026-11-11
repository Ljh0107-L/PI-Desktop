import { createRoot } from 'react-dom/client';
import { App } from './App.jsx';
import './styles.css';
import './workspace.css';
import { getState, setAppearance } from './store.js';

setAppearance(getState().appearance);
createRoot(document.getElementById('root')).render(<App />);
