import { createHash, randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';

const TABLE_TOKEN_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TABLE_TOKEN_LENGTH = 20;

/** Long random tokens need only a fast hash. Device and staff tokens are stored this way. */
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');

export const randomToken = () => randomBytes(32).toString('hex');

/** The code in a table's QR card: unambiguous characters, safe to read aloud. */
export function newTableToken() {
  return Array.from({ length: TABLE_TOKEN_LENGTH }, () => TABLE_TOKEN_ALPHABET[randomInt(TABLE_TOKEN_ALPHABET.length)]).join('');
}

export const newPairingCode = () => String(randomInt(1_000_000)).padStart(6, '0');

/** PINs have only 10,000 values, so they need a deliberately slow hash. */
export const hashPin = (pin) => argon2.hash(pin, { type: argon2.argon2id });

export const verifyPin = (hash, pin) => argon2.verify(hash, pin);
