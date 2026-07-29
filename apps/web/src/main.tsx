import "@xterm/xterm/css/xterm.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { ErrorBoundary } from "./app/ErrorBoundary";
import "./styles/tokens.css";
import "./styles/reset.css";
import "./styles/app.css";
import "./styles/device-icons.css";
import { createBrowserSimWorkerClient } from "./worker/create-client";
import { initializeDeviceIconProfile } from "./hooks/useDeviceIconProfile";

const root = document.getElementById("root");
if (!root) throw new Error("Application root element is missing");

const client = createBrowserSimWorkerClient();
initializeDeviceIconProfile();
window.addEventListener("beforeunload", () => client.terminate(), { once: true });

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary><App client={client} /></ErrorBoundary>
  </StrictMode>,
);
