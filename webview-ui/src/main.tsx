import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";

declare global {
  interface Window {
    __AEVI_VIEW__?: "router" | "chat";
  }
}

async function bootstrap() {
  const view = window.__AEVI_VIEW__ ?? "chat";

  if (view === "router") {
    const { default: RouterApp } = await import("./router/RouterApp");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <RouterApp />
      </StrictMode>
    );
  } else {
    const { default: App } = await import("./App");
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>
    );
  }
}

bootstrap();