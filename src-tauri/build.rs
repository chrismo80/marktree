fn main() {
    // Otherwise a release build keeps embedding the old icon after `npm run icons`.
    println!("cargo:rerun-if-changed=icons/icon.ico");
    tauri_build::build()
}
