export const unwrap = <T>(value: T | undefined | null): T => {
  if (value === undefined || value === null) {
    throw new Error("Value is undefined or null");
  }
  return value;
};

export const withLatency = async <T>(fn: () => Promise<T>): Promise<{ return: T; latency: number }> => {
  const start = Date.now();
  const ret = await fn();
  return { return: ret, latency: (Date.now() - start) / 1000 }; // in seconds for backword compatibility
};
