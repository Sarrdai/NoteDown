//! ML-KEM-768 (FIPS 203) for NoteDown's app as WebAssembly without imports: libcrux-ml-kem behind three
//! functions that work on one shared buffer (app/vendor/mlkem.js is the loader). The caller passes all
//! randomness in, so the module needs no host functions; the private key is never exported, only its
//! 64-byte seed (d ‖ z) goes in and the key is regenerated from it for each decapsulation.
#![no_std]

use libcrux_ml_kem::mlkem768::{self, MlKem768Ciphertext, MlKem768PublicKey};

const SEED: usize = 64;
const RAND: usize = 32;
const PK: usize = 1184;
const CT: usize = 1088;
const SS: usize = 32;
const BUF: usize = 4096;

static mut BUFFER: [u8; BUF] = [0; BUF];

#[allow(static_mut_refs)]
fn buffer() -> &'static mut [u8; BUF] {
    // Single-threaded WebAssembly: the loader calls one function at a time.
    unsafe { &mut BUFFER }
}

/// Address of the shared buffer (4096 bytes).
#[no_mangle]
pub extern "C" fn mlkem_buffer() -> *mut u8 {
    buffer().as_mut_ptr()
}

/// In: seed (64) at 0. Out: encapsulation key (1184) at 0.
#[no_mangle]
pub extern "C" fn mlkem_keygen() {
    let buf = buffer();
    let mut seed = [0u8; SEED];
    seed.copy_from_slice(&buf[..SEED]);
    let pair = mlkem768::generate_key_pair(seed);
    buf[..PK].copy_from_slice(pair.public_key().as_slice());
}

/// In: encapsulation key (1184) at 0, randomness (32) after it. Out: ciphertext (1088) at 0, shared
/// secret (32) after it. Returns 1, or 0 for an invalid encapsulation key (FIPS 203 modulus check).
#[no_mangle]
pub extern "C" fn mlkem_encapsulate() -> u32 {
    let buf = buffer();
    let mut pk = [0u8; PK];
    pk.copy_from_slice(&buf[..PK]);
    let mut rand = [0u8; RAND];
    rand.copy_from_slice(&buf[PK..PK + RAND]);
    let public_key = MlKem768PublicKey::from(pk);
    if !mlkem768::validate_public_key(&public_key) {
        return 0;
    }
    let (ct, ss) = mlkem768::encapsulate(&public_key, rand);
    buf[..CT].copy_from_slice(ct.as_slice());
    buf[CT..CT + SS].copy_from_slice(&ss);
    buf[CT + SS..PK + RAND].fill(0);
    1
}

/// In: seed (64) at 0, ciphertext (1088) after it. Out: shared secret (32) at 0 (implicit rejection:
/// a wrong ciphertext gives a pseudorandom secret, so the AES-GCM tag check fails afterwards).
#[no_mangle]
pub extern "C" fn mlkem_decapsulate() {
    let buf = buffer();
    let mut seed = [0u8; SEED];
    seed.copy_from_slice(&buf[..SEED]);
    let mut ct = [0u8; CT];
    ct.copy_from_slice(&buf[SEED..SEED + CT]);
    let pair = mlkem768::generate_key_pair(seed);
    let ss = mlkem768::decapsulate(pair.private_key(), &MlKem768Ciphertext::from(ct));
    buf[..SS].copy_from_slice(&ss);
    buf[SS..SEED + CT].fill(0);
}

/// Zeroes the buffer (the loader calls it after reading a result).
#[no_mangle]
pub extern "C" fn mlkem_wipe() {
    buffer().fill(0);
}

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}
