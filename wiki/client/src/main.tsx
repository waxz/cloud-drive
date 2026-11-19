import '@mantine/core/styles.css';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';
import './styles.css';
import { MantineProvider } from '@mantine/core';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// No StrictMode: its double mount would tear down the live sync connection.
createRoot(document.getElementById('root')!).render(
  <MantineProvider defaultColorScheme="auto" theme={{ fontFamily: 'Inter, system-ui, sans-serif', primaryColor: 'blue' }}>
    <App />
  </MantineProvider>
);
