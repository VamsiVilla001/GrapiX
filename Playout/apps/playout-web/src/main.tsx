import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { VirtualOutputWindow } from "./VirtualOutputWindow";
import "./styles.css";

const params = new URLSearchParams(window.location.search);
const virtualOutput = params.get("virtualOutput");
const content = virtualOutput === "program"
  ? <VirtualOutputWindow outputId={params.get("outputId") ?? "virtual"} />
  : <App />;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {content}
  </React.StrictMode>
);
