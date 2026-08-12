const counters = new Map<string, number>();

export const incrementMetric = (name: string): void => {
  counters.set(name, (counters.get(name) ?? 0) + 1);
};

export const getMetrics = (): Record<string, number> =>
  Object.fromEntries(counters.entries());
