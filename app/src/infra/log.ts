/** Structured JSON logs, one object per line, so CloudWatch Logs Insights can query fields directly. */
export const log = (event: string, fields: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
};
