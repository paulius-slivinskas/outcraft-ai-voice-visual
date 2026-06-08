import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Demo from "./Demo";
import "../styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element not found");
}

createRoot(rootElement).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
