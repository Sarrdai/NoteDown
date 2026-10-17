#!/usr/bin/env bash
# Rebuilds app/vendor/mlkem.wasm from the pinned libcrux-ml-kem (Cargo.toml, Cargo.lock) with the pinned
# toolchain (rust-toolchain.toml). Only run when updating; the output is committed. Reproducible: the same
# inputs give the same bytes (checked by comparing sha256sum with the committed file).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
target="${CARGO_TARGET_DIR:-$(mktemp -d)}"
export CARGO_TARGET_DIR="$target"
export RUSTFLAGS="--remap-path-prefix=$HOME=/home --remap-path-prefix=$here=/src -C target-cpu=mvp"
cd "$here"
rustup target add wasm32-unknown-unknown >/dev/null
cargo build --locked --release --target wasm32-unknown-unknown
cp "$target/wasm32-unknown-unknown/release/notedown_mlkem.wasm" "$root/app/vendor/mlkem.wasm"
version="$(sed -n 's/^libcrux-ml-kem = { version = "=\([^"]*\)".*/\1/p' Cargo.toml)"
curl -fsSL "https://raw.githubusercontent.com/cryspen/libcrux/libcrux-ml-kem-v$version/LICENSE" -o "$root/app/vendor/mlkem.LICENSE"
sha256sum "$root/app/vendor/mlkem.wasm"
