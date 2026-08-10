import "vite/modulepreload-polyfill";
import "./app.scss";

const status = document.querySelector<HTMLElement>("#vite-status");

if (status) {
  status.textContent = "Pannonico demo TypeScript is active.";
  status.dataset.vite = "ready";
}
