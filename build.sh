#!/bin/bash
set -euo pipefail

APP_NAME="${APP_NAME:-Agent Island}"
BUNDLE_ID="${BUNDLE_ID:-com.agentbro.desktop}"
BUILD_DIR="src-tauri/target"
DIST_DIR="dist"
DMG_NAME="${DMG_NAME:-Agent Island.dmg}"
APP_VERSION="${APP_VERSION:-$(node -e "console.log(JSON.parse(require('fs').readFileSync('src-tauri/tauri.conf.json', 'utf8')).version)" 2>/dev/null || echo "0.0.0")}"
UPDATE_ARCHIVE_NAME="${UPDATE_ARCHIVE_NAME:-$APP_NAME.app.tar.gz}"
UPDATE_MANIFEST_NAME="${UPDATE_MANIFEST_NAME:-latest.json}"

NOTARIZE=false
SKIP_SIGN="${SKIP_SIGN:-0}"
SKIP_NOTARIZE="${SKIP_NOTARIZE:-0}"

usage() {
    cat <<'EOF'
Usage: ./build.sh [--notarize] [--help]

  --notarize    Sign and notarize the app bundle and DMG
  --help        Show this help

Environment variables:
  SKIP_SIGN=1         Skip code signing
  SKIP_NOTARIZE=1     Skip notarization (signing still happens)
  CODESIGN_IDENTITY   Code signing identity (Developer ID Application: ...)
  APPLE_ID            Apple ID for notarization
  APPLE_PASSWORD      App-specific password for notarization
  APPLE_TEAM_ID       Apple Team ID
  UPDATE_BASE_URL     Base URL for updater archive links in latest.json
EOF
}

for arg in "$@"; do
    case "$arg" in
        --notarize)
            NOTARIZE=true
            ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $arg" >&2
            usage >&2
            exit 1
            ;;
    esac
done

check_deps() {
    local missing=()
    for cmd in cargo pnpm node tar shasum create-dmg lipo ditto; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            missing+=("$cmd")
        fi
    done
    if [ ${#missing[@]} -gt 0 ]; then
        echo "Missing dependencies: ${missing[*]}" >&2
        echo "Install with: brew install create-dmg && cargo --version && pnpm --version && node --version" >&2
        exit 1
    fi
}

build_app_bundle() {
    echo "==> Building Tauri universal app bundle..."
    local tauri_app="$BUILD_DIR/universal-apple-darwin/release/bundle/macos/$APP_NAME.app"
    local bridge_out="$BUILD_DIR/universal-apple-darwin/release/agent-island-bridge"

    echo "==> Building universal bridge helper..."
    mkdir -p "$BUILD_DIR/agent-island-bridge-resource"
    touch "$BUILD_DIR/agent-island-bridge-resource/agent-island-bridge"
    cargo build --release --target aarch64-apple-darwin --bin agent-island-bridge --manifest-path src-tauri/Cargo.toml
    cargo build --release --target x86_64-apple-darwin --bin agent-island-bridge --manifest-path src-tauri/Cargo.toml
    mkdir -p "$(dirname "$bridge_out")"
    lipo -create \
        "$BUILD_DIR/aarch64-apple-darwin/release/agent-island-bridge" \
        "$BUILD_DIR/x86_64-apple-darwin/release/agent-island-bridge" \
        -output "$bridge_out"
    cp "$bridge_out" "$BUILD_DIR/agent-island-bridge-resource/agent-island-bridge"
    chmod +x "$BUILD_DIR/agent-island-bridge-resource/agent-island-bridge"

    cargo tauri build \
        --target universal-apple-darwin \
        --bundles app \
        --no-sign \
        --ci \
        --config '{"bundle":{"createUpdaterArtifacts":false}}'

    if [ ! -d "$tauri_app" ]; then
        echo "Tauri app bundle not found: $tauri_app" >&2
        exit 1
    fi

    rm -rf "$DIST_DIR/$APP_NAME.app"
    mkdir -p "$DIST_DIR"
    cp -R "$tauri_app" "$DIST_DIR/$APP_NAME.app"
}

sign_app() {
    if [ "$SKIP_SIGN" = "1" ]; then
        echo "==> Skipping code signing (SKIP_SIGN=1)"
        return
    fi

    local identity="${CODESIGN_IDENTITY:-}"
    if [ -z "$identity" ]; then
        echo "==> No CODESIGN_IDENTITY set, skipping signing"
        return
    fi

    echo "==> Signing app bundle..."
    local entitlements="src-tauri/Entitlements.plist"
    local app_path="$DIST_DIR/$APP_NAME.app"
    local resource_bridge="$app_path/Contents/Resources/agent-island-bridge"

    while IFS= read -r binary; do
        if [ ! -x "$binary" ]; then
            continue
        fi
        echo "==> Signing executable: $binary"
        codesign --force --timestamp --options runtime \
            --entitlements "$entitlements" \
            --sign "$identity" \
            "$binary"
    done < <(find "$app_path/Contents/MacOS" -type f)

    if [ -f "$resource_bridge" ]; then
        chmod +x "$resource_bridge"
        echo "==> Signing executable resource: $resource_bridge"
        codesign --force --timestamp --options runtime \
            --entitlements "$entitlements" \
            --sign "$identity" \
            "$resource_bridge"
    fi

    echo "==> Signing app container..."
    codesign --force --timestamp --options runtime \
        --entitlements "$entitlements" \
        --sign "$identity" \
        "$app_path"

    echo "==> Verifying signature..."
    codesign --verify --strict --verbose=2 "$app_path"
    codesign -dv --verbose=4 "$app_path"
    spctl --assess --type exec "$app_path" 2>/dev/null || echo "Note: spctl assessment skipped (no Gatekeeper on CI)"
}

create_updater_archive() {
    echo "==> Creating updater archive..."
    local archive_path="$DIST_DIR/$UPDATE_ARCHIVE_NAME"
    rm -f "$archive_path" "$archive_path.sig"

    tar -czf "$archive_path" -C "$DIST_DIR" "$APP_NAME.app"

    if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
        echo "==> Signing updater archive..."
        cargo tauri signer sign -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" "$archive_path" >/dev/null
    else
        echo "==> Skipping updater archive signing (TAURI_SIGNING_PRIVATE_KEY not set)"
    fi

    if [ -n "${UPDATE_BASE_URL:-}" ] && [ -f "$archive_path.sig" ]; then
        echo "==> Writing updater manifest..."
        VERSION="$APP_VERSION" \
        UPDATE_ARCHIVE_PATH="$archive_path" \
        UPDATE_ARCHIVE_URL="${UPDATE_BASE_URL%/}/$UPDATE_ARCHIVE_NAME" \
        UPDATE_SIGNATURE_PATH="$archive_path.sig" \
        UPDATE_MANIFEST_PATH="$DIST_DIR/$UPDATE_MANIFEST_NAME" \
            node scripts/create-updater-manifest.mjs
    fi
}

create_dmg() {
    echo "==> Creating DMG..."
    mkdir -p "$DIST_DIR"
    local app_path="$DIST_DIR/$APP_NAME.app"
    local dmg_path="$DIST_DIR/$DMG_NAME"
    rm -f "$dmg_path"

    create-dmg \
        --volname "$APP_NAME" \
        --window-pos 200 120 \
        --window-size 600 400 \
        --icon-size 100 \
        --icon "$APP_NAME.app" 175 190 \
        --hide-extension "$APP_NAME.app" \
        --app-drop-link 425 190 \
        "$dmg_path" \
        "$app_path"

    echo "DMG created: $dmg_path"
}

sign_dmg() {
    if [ "$SKIP_SIGN" = "1" ]; then
        return
    fi
    local identity="${CODESIGN_IDENTITY:-}"
    if [ -z "$identity" ]; then
        return
    fi

    echo "==> Signing DMG..."
    codesign --force --sign "$identity" "$DIST_DIR/$DMG_NAME"
}

json_field() {
    node -e '
const field = process.argv[1];
let input = "";
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const data = JSON.parse(input);
  const value = field.split(".").reduce((acc, key) => acc && acc[key], data);
  if (value !== undefined && value !== null) process.stdout.write(String(value));
});
' "$1"
}

notary_submit_and_wait() {
    local target_path="$1"
    local apple_id="${APPLE_ID:-}"
    local apple_password="${APPLE_PASSWORD:-}"
    local team_id="${APPLE_TEAM_ID:-}"

    if [ -z "$apple_id" ] || [ -z "$apple_password" ] || [ -z "$team_id" ]; then
        echo "==> Notarization credentials not set, skipping"
        return 1
    fi

    local timeout_seconds="${NOTARY_TIMEOUT_SECONDS:-5400}"
    local poll_seconds="${NOTARY_POLL_SECONDS:-60}"
    local submitted_at
    local submission_output
    local submission_id
    submitted_at="$(date +%s)"

    print_notary_log() {
        local id="$1"
        echo "==> Notarization log for $id"
        xcrun notarytool log "$id" \
            --apple-id "$apple_id" \
            --password "$apple_password" \
            --team-id "$team_id" || true
    }

    echo "==> Submitting for notarization: $target_path"
    submission_output="$(xcrun notarytool submit "$target_path" \
        --apple-id "$apple_id" \
        --password "$apple_password" \
        --team-id "$team_id" \
        --output-format json)"
    echo "$submission_output"
    submission_id="$(printf '%s' "$submission_output" | json_field id)"

    if [ -z "$submission_id" ]; then
        echo "Unable to read notarization submission id" >&2
        exit 1
    fi

    echo "==> Notarization submission id: $submission_id"
    while true; do
        local info_output
        local status
        info_output="$(xcrun notarytool info "$submission_id" \
            --apple-id "$apple_id" \
            --password "$apple_password" \
            --team-id "$team_id" \
            --output-format json)"
        echo "$info_output"
        status="$(printf '%s' "$info_output" | json_field status)"

        case "$status" in
            Accepted)
                break
                ;;
            Invalid|Rejected)
                print_notary_log "$submission_id"
                exit 1
                ;;
            *)
                local now
                now="$(date +%s)"
                if [ $((now - submitted_at)) -ge "$timeout_seconds" ]; then
                    echo "Timed out waiting for notarization after ${timeout_seconds}s" >&2
                    print_notary_log "$submission_id"
                    exit 124
                fi
                echo "Current notarization status: ${status:-unknown}; waiting ${poll_seconds}s..."
                sleep "$poll_seconds"
                ;;
        esac
    done
}

notarize_app_bundle() {
    if [ "$SKIP_NOTARIZE" = "1" ] || [ "$NOTARIZE" = "false" ]; then
        echo "==> Skipping notarization"
        return
    fi

    local app_path="$DIST_DIR/$APP_NAME.app"
    local zip_path="$DIST_DIR/$APP_NAME.app.zip"
    if [ ! -d "$app_path" ]; then
        echo "App bundle not found: $app_path" >&2
        exit 1
    fi

    echo "==> Creating app notarization archive..."
    rm -f "$zip_path"
    ditto -c -k --keepParent "$app_path" "$zip_path"
    if ! notary_submit_and_wait "$zip_path"; then
        rm -f "$zip_path"
        return
    fi
    rm -f "$zip_path"

    echo "==> Stapling notarization ticket to app..."
    xcrun stapler staple "$app_path"
    xcrun stapler validate "$app_path"
}

notarize_dmg() {
    if [ "$SKIP_NOTARIZE" = "1" ] || [ "$NOTARIZE" = "false" ]; then
        echo "==> Skipping notarization"
        return
    fi

    local dmg_path="$DIST_DIR/$DMG_NAME"
    if ! notary_submit_and_wait "$dmg_path"; then
        return
    fi

    echo "==> Stapling notarization ticket..."
    xcrun stapler staple "$dmg_path"
    xcrun stapler validate "$dmg_path"
}

create_checksums() {
    echo "==> Creating checksums..."
    find "$DIST_DIR" -maxdepth 1 -type f \
        \( -name "*.dmg" -o -name "*.tar.gz" -o -name "*.sig" -o -name "*.json" \) \
        -print0 |
        sort -z |
        xargs -0 shasum -a 256 > "$DIST_DIR/checksums.txt"
}

main() {
    check_deps
    build_app_bundle
    sign_app
    notarize_app_bundle
    create_updater_archive
    create_dmg
    sign_dmg
    notarize_dmg
    create_checksums
    echo "==> Build complete: $DIST_DIR/$DMG_NAME"
}

main
