import { galleryData } from "./gallery-data";
import { AmbientStaticRenderer, renderVisualPngBytes } from "./renderer";
import type { FormatConfig, PluginMainMessage, StaticVisualSnapshot } from "./types";

const formatOptions = [
  { exportHeight: 1080, exportWidth: 1080, height: 1, label: "1:1", name: "1080 x 1080", width: 1 },
  { exportHeight: 1440, exportWidth: 1080, height: 4, label: "3:4", name: "1080 x 1440", width: 3 },
  { exportHeight: 1080, exportWidth: 1440, height: 3, label: "4:3", name: "1440 x 1080", width: 4 },
  { exportHeight: 1080, exportWidth: 1920, height: 9, label: "16:9", name: "1920 x 1080", width: 16 },
  { exportHeight: 1920, exportWidth: 1080, height: 16, label: "9:16", name: "1080 x 1920", width: 9 },
] satisfies FormatConfig[];

const frameMax = 500000;
const app = document.querySelector<HTMLDivElement>("#app");
let previewRenderer: AmbientStaticRenderer | null = null;

const firstVisual = galleryData.items[0] ?? null;
const state = {
  frame: firstVisual?.mesh.frame ?? 0,
  formatLabel: firstVisual?.format.label ?? "1:1",
  isInserting: false,
  query: "",
  scale: 2,
  selectedId: firstVisual?.id ?? "",
  status: "",
};

if (!app) {
  throw new Error("Plugin UI root was not found.");
}

render();

window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginMainMessage }>) => {
  const message = event.data.pluginMessage;

  if (!message) {
    return;
  }

  state.isInserting = false;
  state.status =
    message.type === "insert-complete"
      ? "Inserted on canvas."
      : message.message;
  render();
};

function render() {
  previewRenderer?.dispose();
  previewRenderer = null;

  const visual = getSelectedVisual();
  const format = getSelectedFormat();
  const filteredItems = getFilteredItems();

  app.innerHTML = `
    <style>${styles}</style>
    <main class="shell">
      <header>
        <div>
          <h1>Outcraft Static Visuals</h1>
          <p>${galleryData.items.length} saved setups</p>
        </div>
      </header>

      <label class="field">
        <span>Search</span>
        <input id="search" type="search" value="${escapeHtml(state.query)}" placeholder="Filter presets" />
      </label>

      <label class="field">
        <span>Preset</span>
        <select id="preset">
          ${renderPresetOptions(filteredItems)}
        </select>
      </label>

      <section class="preview-wrap" style="aspect-ratio: ${format.width} / ${format.height}">
        <canvas id="preview" aria-label="Preview"></canvas>
      </section>

      <section class="formats" aria-label="Format">
        ${formatOptions.map((option) => `
          <button
            class="${option.label === state.formatLabel ? "active" : ""}"
            data-format="${option.label}"
            type="button"
          >
            <strong>${option.label}</strong>
            <span>${option.name}</span>
          </button>
        `).join("")}
      </section>

      <label class="field">
        <span class="row">
          <span>Frame</span>
          <strong data-frame-value>${Math.round(state.frame).toLocaleString("en-US")}</strong>
        </span>
        <input id="frame" max="${frameMax}" min="0" step="1" type="range" value="${state.frame}" />
      </label>

      <div class="row-controls">
        <label class="field">
          <span>Resolution</span>
          <select id="scale">
            <option value="1" ${state.scale === 1 ? "selected" : ""}>1x PNG</option>
            <option value="2" ${state.scale === 2 ? "selected" : ""}>2x PNG</option>
          </select>
        </label>
        <button id="insert" type="button" ${state.isInserting || !visual ? "disabled" : ""}>
          ${state.isInserting ? "Rendering..." : "Insert to Figma"}
        </button>
      </div>

      <p class="status">${escapeHtml(state.status)}</p>
    </main>
  `;

  bindControls();
  renderPreview();
}

function bindControls() {
  const search = document.querySelector<HTMLInputElement>("#search");
  const preset = document.querySelector<HTMLSelectElement>("#preset");
  const frame = document.querySelector<HTMLInputElement>("#frame");
  const scale = document.querySelector<HTMLSelectElement>("#scale");
  const insert = document.querySelector<HTMLButtonElement>("#insert");

  search?.addEventListener("input", () => {
    state.query = search.value;
    const filteredItems = getFilteredItems();
    if (!filteredItems.some((item) => item.id === state.selectedId)) {
      selectVisual(filteredItems[0] ?? galleryData.items[0] ?? null);
    }
    render();
  });

  preset?.addEventListener("change", () => {
    selectVisual(galleryData.items.find((item) => item.id === preset.value) ?? null);
    render();
  });

  frame?.addEventListener("input", () => {
    state.frame = clampFrame(Number(frame.value));
    const frameValue = document.querySelector<HTMLElement>("[data-frame-value]");

    if (frameValue) {
      frameValue.textContent = Math.round(state.frame).toLocaleString("en-US");
    }

    renderPreview();
  });

  scale?.addEventListener("change", () => {
    state.scale = Number(scale.value) === 1 ? 1 : 2;
    render();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-format]").forEach((button) => {
    button.addEventListener("click", () => {
      state.formatLabel = button.dataset.format ?? state.formatLabel;
      render();
    });
  });

  insert?.addEventListener("click", () => {
    void insertVisual();
  });
}

function renderPreview() {
  previewRenderer?.dispose();
  previewRenderer = null;

  const visual = getSelectedVisual();
  const format = getSelectedFormat();
  const canvas = document.querySelector<HTMLCanvasElement>("#preview");

  if (!visual || !canvas) {
    return;
  }

  const ratio = format.width / format.height;
  const width = ratio >= 1 ? 720 : Math.round(720 * ratio);
  const height = ratio >= 1 ? Math.round(720 / ratio) : 720;

  previewRenderer = new AmbientStaticRenderer(canvas);
  previewRenderer.render(visual, format, {
    frame: state.frame,
    height,
    width,
  });
}

async function insertVisual() {
  const visual = getSelectedVisual();
  const format = getSelectedFormat();

  if (!visual || state.isInserting) {
    return;
  }

  state.isInserting = true;
  state.status = `Rendering ${format.label} ${state.scale}x...`;
  render();

  try {
    const bytes = await renderVisualPngBytes(visual, format, {
      frame: state.frame,
      scale: state.scale,
    });

    parent.postMessage(
      {
        pluginMessage: {
          bytes,
          height: format.exportHeight,
          name: `${visual.name} ${format.label}`,
          type: "insert-visual",
          width: format.exportWidth,
        },
      },
      "https://www.figma.com",
    );
  } catch (error) {
    state.isInserting = false;
    state.status = error instanceof Error ? error.message : "Could not render visual.";
    render();
  }
}

function selectVisual(visual: StaticVisualSnapshot | null) {
  if (!visual) {
    state.selectedId = "";
    return;
  }

  state.selectedId = visual.id;
  state.frame = clampFrame(visual.mesh.frame);
  state.formatLabel = formatOptions.some((option) => option.label === visual.format.label)
    ? visual.format.label
    : "1:1";
}

function getSelectedVisual() {
  return (
    galleryData.items.find((item) => item.id === state.selectedId) ??
    galleryData.items[0] ??
    null
  );
}

function getSelectedFormat() {
  return (
    formatOptions.find((format) => format.label === state.formatLabel) ??
    formatOptions[0]
  );
}

function getFilteredItems() {
  const query = state.query.trim().toLowerCase();

  if (!query) {
    return galleryData.items;
  }

  return galleryData.items.filter((item) =>
    item.name.toLowerCase().includes(query),
  );
}

function renderPresetOptions(items: StaticVisualSnapshot[]) {
  if (items.length === 0) {
    return `<option value="">No presets found</option>`;
  }

  return galleryData.sections.map((section) => {
    const sectionItems = items.filter((item) => item.sectionId === section.id);

    if (sectionItems.length === 0) {
      return "";
    }

    return `
      <optgroup label="${escapeHtml(section.name)}">
        ${sectionItems.map((item) => `
          <option value="${escapeHtml(item.id)}" ${item.id === state.selectedId ? "selected" : ""}>
            ${escapeHtml(item.name)}
          </option>
        `).join("")}
      </optgroup>
    `;
  }).join("");
}

function clampFrame(value: number) {
  return Math.max(0, Math.min(frameMax, Number.isFinite(value) ? value : 0));
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const styles = `
  :root {
    color-scheme: light dark;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }

  * {
    box-sizing: border-box;
  }

  body {
    margin: 0;
    background: var(--figma-color-bg);
    color: var(--figma-color-text);
  }

  button,
  input,
  select {
    font: inherit;
  }

  .shell {
    display: grid;
    gap: 14px;
    padding: 16px;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: 15px;
    font-weight: 700;
    line-height: 1.2;
  }

  header p,
  .status,
  .field > span,
  .formats button span {
    color: var(--figma-color-text-secondary);
    font-size: 11px;
    line-height: 1.2;
  }

  .field {
    display: grid;
    gap: 7px;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .row strong {
    color: var(--figma-color-text);
    font-size: 11px;
  }

  input,
  select {
    min-height: 34px;
    width: 100%;
    border: 1px solid var(--figma-color-border);
    border-radius: 6px;
    background: var(--figma-color-bg-secondary);
    color: var(--figma-color-text);
    padding: 0 10px;
    outline: none;
  }

  input[type="range"] {
    padding: 0;
  }

  input:focus,
  select:focus,
  button:focus-visible {
    border-color: var(--figma-color-border-brand-strong);
    box-shadow: 0 0 0 2px var(--figma-color-border-brand);
  }

  .preview-wrap {
    display: grid;
    place-items: center;
    width: 100%;
    min-height: 180px;
    overflow: hidden;
    border: 1px solid var(--figma-color-border);
    border-radius: 8px;
    background: #01151e;
  }

  #preview {
    display: block;
    width: 100%;
    height: 100%;
  }

  .formats {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 6px;
  }

  .formats button {
    display: grid;
    gap: 3px;
    min-height: 48px;
    border: 1px solid var(--figma-color-border);
    border-radius: 6px;
    background: var(--figma-color-bg-secondary);
    color: var(--figma-color-text);
    padding: 7px 5px;
    text-align: center;
  }

  .formats button.active {
    border-color: var(--figma-color-border-brand-strong);
    background: var(--figma-color-bg-brand);
    color: var(--figma-color-text-onbrand);
  }

  .formats button.active span {
    color: currentColor;
    opacity: 0.78;
  }

  .formats strong {
    font-size: 12px;
    line-height: 1;
  }

  .row-controls {
    display: grid;
    grid-template-columns: 110px minmax(0, 1fr);
    gap: 8px;
    align-items: end;
  }

  #insert {
    min-height: 34px;
    border: 1px solid var(--figma-color-border-brand-strong);
    border-radius: 6px;
    background: var(--figma-color-bg-brand);
    color: var(--figma-color-text-onbrand);
    font-weight: 700;
  }

  #insert:disabled {
    opacity: 0.5;
  }
`;
