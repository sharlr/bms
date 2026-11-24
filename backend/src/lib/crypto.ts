import crypto from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { config } from '../config.js';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// OWASP-recommended argon2id parameters.
const ARGON = { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export const hashSecret = (plain: string) => hash(plain, ARGON);
export async function verifySecret(stored: string | null | undefined, plain: string): Promise<boolean> {
  if (!stored) {
    // Constant-ish time: still do a hash so timing doesn't reveal missing users.
    await hash(plain, ARGON);
    return false;
  }
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

const key = () => Buffer.from(config.SECRETS_KEY, 'hex');

/** AES-256-GCM; output = base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decrypt(data: string): string {
  const buf = Buffer.from(data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export const isStrongPassword = (p: string) =>
  p.length >= 10 && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p);

const WEAK_PINS = new Set(['0000', '1111', '1234', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '4321', '1212']);
export const isAcceptablePin = (p: string) => /^\d{4}$/.test(p) && !WEAK_PINS.has(p);
