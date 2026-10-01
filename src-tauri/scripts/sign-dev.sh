#!/bin/sh
# Cargo runner (wired in .cargo/config.toml): re-sign every debug binary with one stable local identity before it
# runs. Cargo's default ad-hoc signature changes on every build, so macOS Keychain saw a "new app" each time and
# re-asked for the three com.flowgardens.command items; with a stable signature "Always Allow" sticks.
# The identifier matches tauri.conf.json so the bundled .app shares the same Keychain approval.
# ponytail: self-signed "LocalFlow Signing" cert; on a Mac without it codesign fails and the binary runs unsigned (prompts return).
bin="$1"; shift
codesign --force --sign "LocalFlow Signing" --identifier com.flowgardens.command --timestamp=none "$bin" 2>/dev/null \
  || echo "sign-dev.sh: codesign failed, running unsigned (Keychain will prompt)" >&2
exec "$bin" "$@"
