import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { mnemonicToSeed, validateMnemonic } from "bip39";

async function hmacSha512(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data as BufferSource));
}

/** SLIP-10 ed25519 derivation along m/44'/coin'/account' (all hardened). */
async function deriveEd25519(seed: Uint8Array, path: number[]): Promise<Uint8Array> {
  let I = await hmacSha512(new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const idx of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    const hardened = (idx | 0x80000000) >>> 0;
    new DataView(data.buffer).setUint32(33, hardened, false);
    I = await hmacSha512(chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

export async function keypairFromCredential(
  credential: string,
  coinType: number,
  accountIndex = 0,
): Promise<Keypair> {
  const value = credential.trim();
  if (StrKey.isValidEd25519SecretSeed(value)) return Keypair.fromSecret(value);
  const words = value.toLowerCase().split(/\s+/).join(" ");
  if (!validateMnemonic(words)) {
    throw new Error("Credential is neither a valid S... secret key nor a valid BIP-39 mnemonic.");
  }
  const seed = new Uint8Array(await mnemonicToSeed(words));
  const raw = await deriveEd25519(seed, [44, coinType, accountIndex]);
  return Keypair.fromRawEd25519Seed(raw as unknown as Buffer);
}

export function isValidDestination(addr: string) {
  const a = addr.trim();
  return StrKey.isValidEd25519PublicKey(a) || StrKey.isValidMed25519PublicKey(a);
}
