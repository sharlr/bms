import { z, type ZodTypeAny } from 'zod';

export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  return schema.parse(data ?? {});
}

// Strip control chars & angle brackets, trim. Output is also escaped by React; this is defence in depth
// (receipts / KOT printers render raw text).
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F<>]/g;
export const text = (max = 200) =>
  z.string().transform((s) => s.replace(CONTROL, '').trim()).pipe(z.string().max(max));
export const reqText = (max = 200) =>
  z.string().transform((s) => s.replace(CONTROL, '').trim()).pipe(z.string().min(1).max(max));

export const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const money = z.coerce.number().finite().min(0).max(1_000_000_000);
export const qty = z.coerce.number().finite().positive().max(100_000);
export const currency = z.string().regex(/^[A-Z]{3}$/);
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const idParam = z.object({ id });
