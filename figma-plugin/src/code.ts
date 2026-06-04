import type { PluginUiMessage } from "./types";

declare const __html__: string;

type FigmaImage = {
  hash: string;
};

type FigmaRectangleNode = {
  fills: unknown[];
  name: string;
  resize: (width: number, height: number) => void;
  x: number;
  y: number;
};

type FigmaPluginApi = {
  createImage: (data: Uint8Array) => FigmaImage;
  createRectangle: () => FigmaRectangleNode;
  currentPage: {
    appendChild: (node: FigmaRectangleNode) => void;
    selection: FigmaRectangleNode[];
  };
  notify: (message: string) => void;
  showUI: (html: string, options: { height: number; themeColors: boolean; width: number }) => void;
  ui: {
    onmessage: ((message: PluginUiMessage) => void) | null;
    postMessage: (message: unknown) => void;
  };
  viewport: {
    center: { x: number; y: number };
    scrollAndZoomIntoView: (nodes: FigmaRectangleNode[]) => void;
  };
};

declare const figma: FigmaPluginApi;

figma.showUI(__html__, {
  height: 640,
  themeColors: true,
  width: 380,
});

figma.ui.onmessage = (message) => {
  if (message.type === "notify") {
    figma.notify(message.message);
    return;
  }

  if (message.type !== "insert-visual") {
    return;
  }

  try {
    const image = figma.createImage(message.bytes);
    const node = figma.createRectangle();

    node.name = message.name;
    node.resize(message.width, message.height);
    node.x = figma.viewport.center.x - message.width / 2;
    node.y = figma.viewport.center.y - message.height / 2;
    node.fills = [
      {
        imageHash: image.hash,
        scaleMode: "FILL",
        type: "IMAGE",
      },
    ];

    figma.currentPage.appendChild(node);
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
    figma.notify(`Inserted ${message.name}`);
    figma.ui.postMessage({ type: "insert-complete" });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Could not insert visual.";

    figma.notify(errorMessage);
    figma.ui.postMessage({ message: errorMessage, type: "insert-error" });
  }
};
