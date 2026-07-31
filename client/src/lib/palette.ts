// Small categorical palette for cluster color-coding. Muted to sit on the warm background,
// and chosen to stay distinguishable (including for common color-vision deficiencies).
export const CLUSTER_COLORS = [
  "#3a6ea5", // blue
  "#c85a3a", // terracotta
  "#3f8f6b", // green
  "#b5567f", // magenta
  "#5aa1c9", // sky
  "#c99a3a", // ochre
  "#7a5aa0", // violet
  "#6b7280", // slate
];

export const clusterColorFor = (index: number): string => CLUSTER_COLORS[index % CLUSTER_COLORS.length]!;
