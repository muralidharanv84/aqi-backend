export function minuteBucketTimestamp(nowMs: number): number {
  const nowSeconds = Math.floor(nowMs / 1000);
  return Math.floor(nowSeconds / 60) * 60;
}
