import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/dm-sans";
const App = React.lazy(() => import('./App').then(m => ({ default: m.App })));
import { ErrorBoundary } from './ErrorBoundary';
import "./styles.css";
import "./navigation.css";

createRoot(document.getElementById("root")!).render(<React.StrictMode><ErrorBoundary><React.Suspense fallback={<main className="recovery-screen" role="status">Opening OFFGRID…</main>}><App /></React.Suspense></ErrorBoundary></React.StrictMode>);
