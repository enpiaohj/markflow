import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";
import { initTheme } from "./lib/prefs";

// 在渲染前应用主题，避免深色主题下先闪一下浅色
initTheme();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
