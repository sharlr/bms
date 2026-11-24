export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
export const sum = (arr: number[]) => round2(arr.reduce((a, b) => a + b, 0));
