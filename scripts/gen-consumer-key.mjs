#!/usr/bin/env node
/** Generate an Ed25519 consumer keypair: prints the public key (hex) and the secret (base64). */
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));

const secret = ed.utils.randomPrivateKey();
const publicKey = ed.getPublicKey(secret);
console.log(JSON.stringify({
  public_key_hex: [...publicKey].map((b) => b.toString(16).padStart(2, "0")).join(""),
  secret_b64: Buffer.from(secret).toString("base64"),
}, null, 2));
