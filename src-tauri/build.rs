fn main() {
    ensure_bridge_resource_placeholder();
    ensure_common_controls_v6_for_tests();
    tauri_build::build()
}

fn ensure_common_controls_v6_for_tests() {
    // Unit test harnesses do not receive tauri-build's Windows app manifest.
    // muda statically imports TaskDialogIndirect from comctl32, which only
    // exists in the Common-Controls v6 side-by-side assembly, so without this
    // dependency the loader aborts test binaries with STATUS_ENTRYPOINT_NOT_FOUND.
    // Cargo has no link-arg scope for unit tests, so the flag reaches all targets;
    // binaries keep their embedded manifest.
    let is_windows_msvc = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc");
    if is_windows_msvc {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}

fn ensure_bridge_resource_placeholder() {
    let manifest_dir = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resource_dir = manifest_dir
        .join("target")
        .join("vibe-board-bridge-resource");
    let resource_path = resource_dir.join("vibe-board-bridge");
    if resource_path.exists() {
        return;
    }
    if std::fs::create_dir_all(&resource_dir).is_ok() {
        let _ = std::fs::write(resource_path, []);
    }
}
