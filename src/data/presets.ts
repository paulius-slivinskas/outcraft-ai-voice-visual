import type { GradientPreset } from "../types";

export const gradientPresets: GradientPreset[] = [
  {
    name: "Moss Signal",
    stops: [
      { offset: 0, color: "#111614" },
      { offset: 0.24, color: "#0bbf8a" },
      { offset: 0.52, color: "#e6d450" },
      { offset: 0.78, color: "#ff4d6d" },
      { offset: 1, color: "#f7f7ef" },
    ],
  },
  {
    name: "Glass Ember",
    stops: [
      { offset: 0, color: "#101010" },
      { offset: 0.22, color: "#23c9c8" },
      { offset: 0.5, color: "#f4d35e" },
      { offset: 0.73, color: "#ee4266" },
      { offset: 1, color: "#f8ffe5" },
    ],
  },
  {
    name: "Night Orchard",
    stops: [
      { offset: 0, color: "#121410" },
      { offset: 0.2, color: "#356859" },
      { offset: 0.46, color: "#5dd39e" },
      { offset: 0.7, color: "#f2c14e" },
      { offset: 1, color: "#f05d5e" },
    ],
  },
];
