export const BEACON_CLUSTER_PX = 28;
export const BEACON_EXIT_MS = 400;
export const TRAIL_FADE_MS = 2500;

export function clusterProjectedEvents(points, threshold = BEACON_CLUSTER_PX) {
  const sorted = [...points].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const parent = sorted.map((_, index) => index);
  const find = (index) => parent[index] === index ? index : (parent[index] = find(parent[index]));

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const dx = sorted[i].x - sorted[j].x;
      const dy = sorted[i].y - sorted[j].y;
      if (dx * dx + dy * dy < threshold * threshold) parent[find(j)] = find(i);
    }
  }

  const groups = new Map();
  sorted.forEach((point, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(point);
  });

  return [...groups.values()].map((group) => ({
    key: group.map((point) => point.id).join('|'),
    ids: group.map((point) => point.id),
    x: group.reduce((sum, point) => sum + point.x, 0) / group.length,
    y: group.reduce((sum, point) => sum + point.y, 0) / group.length,
    type: group.length > 1 ? 'cluster' : group[0].type,
    count: group.length,
  }));
}
