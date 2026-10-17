// Loader of mlkem.wasm: ML-KEM-768 (FIPS 203) from libcrux-ml-kem 0.0.11 (Cryspen, Apache-2.0,
// mlkem.LICENSE), built by scripts/vendor/mlkem/build.sh. The module has no imports; randomness comes
// from crypto.getRandomValues here. Written by hand (not generated); keep it this small.
const SEED = 64, PK = 1184, CT = 1088, SS = 32, RAND = 32;

let instance;

async function wasmBytes() {
  const url = new URL("./mlkem.wasm", import.meta.url);
  if (url.protocol === "file:") {   // Node (unit tests, scripts): no fetch for file URLs
    const { readFile } = await import("node:fs/promises");
    return readFile(url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`mlkem.wasm: HTTP ${response.status}`);
  return response.arrayBuffer();
}

async function exports() {
  instance ??= wasmBytes().then(bytes => WebAssembly.instantiate(bytes, {})).then(r => r.instance.exports);
  return instance;
}

// Runs one wasm function on the shared buffer: writes `input`, calls `fn`, copies `outLength` bytes out, wipes.
async function call(name, input, outLength) {
  const wasm = await exports();
  const buffer = new Uint8Array(wasm.memory.buffer, wasm.mlkem_buffer(), 4096);
  try {
    buffer.set(input);
    const ok = wasm[name]();
    if (ok === 0) throw new Error("invalid ML-KEM-768 encapsulation key");
    return buffer.slice(0, outLength);
  } finally {
    wasm.mlkem_wipe();
  }
}

const bytes = (value, length, what) => {
  if (!(value instanceof Uint8Array) || value.length !== length) throw new Error(`${what}: expected ${length} bytes`);
  return value;
};

/** The encapsulation (public) key (1184 bytes) of the key pair from a 64-byte seed (d ‖ z, FIPS 203). */
export function mlkemPublicKey(seed) {
  return call("mlkem_keygen", bytes(seed, SEED, "seed"), PK);
}

/** `{ ciphertext (1088 bytes), sharedSecret (32 bytes) }` for an encapsulation key; throws for an invalid key. */
export async function mlkemEncapsulate(publicKey) {
  const random = globalThis.crypto.getRandomValues(new Uint8Array(RAND));
  const input = new Uint8Array(PK + RAND);
  input.set(bytes(publicKey, PK, "public key"));
  input.set(random, PK);
  const out = await call("mlkem_encapsulate", input, CT + SS);
  return { ciphertext: out.slice(0, CT), sharedSecret: out.slice(CT) };
}

/** The 32-byte shared secret of a ciphertext for the key pair of `seed` (a wrong ciphertext gives a random-looking one). */
export function mlkemDecapsulate(seed, ciphertext) {
  const input = new Uint8Array(SEED + CT);
  input.set(bytes(seed, SEED, "seed"));
  input.set(bytes(ciphertext, CT, "ciphertext"), SEED);
  return call("mlkem_decapsulate", input, SS);
}

export const MLKEM_PUBLIC_KEY_BYTES = PK;
export const MLKEM_CIPHERTEXT_BYTES = CT;
