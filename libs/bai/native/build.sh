#!/usr/bin/env bash
# Build the native shim for the host platform and drop it under
# native/dist/<platform>/libbai.<suffix>. The TS FFI loader looks
# there first.
#
# Cross-compilation to other platforms is not handled here — wire
# that up in CI (see native/README.md sketch).

set -euo pipefail

cd "$(dirname "$0")/rust"

OS=""
SUFFIX=""
case "$(uname -s)" in
  Darwin) OS="darwin"; SUFFIX="dylib" ;;
  Linux)  OS="linux";  SUFFIX="so" ;;
  *)      echo "unsupported host: $(uname -s)" >&2; exit 1 ;;
esac

ARCH=""
case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

FEATURE="cpu"
if [[ "${BAI_FEATURE:-}" != "" ]]; then
  FEATURE="${BAI_FEATURE}"
fi

cargo build --release --no-default-features --features "${FEATURE}"

DEST="../dist/${OS}-${ARCH}"
mkdir -p "${DEST}"
cp "target/release/libbai.${SUFFIX}" "${DEST}/libbai.${SUFFIX}"
echo "built ${DEST}/libbai.${SUFFIX}"
