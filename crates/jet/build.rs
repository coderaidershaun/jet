//! Lets a Jet built with Phonon-2 find the CrispASR library it loads at start: in the folders of
//! `target` where the library was built, or, once copied out of `target`, beside the program.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // The speech library's own build hands these folders only to crates that depend on it directly.
    let mut built = false;
    for key in ["DEP_CRISPASR_LIBDIR", "DEP_CRISPASR_GGMLDIR"] {
        println!("cargo:rerun-if-env-changed={key}");
        if let Ok(folder) = std::env::var(key) {
            println!("cargo:rustc-link-arg=-Wl,-rpath,{folder}");
            built = true;
        }
    }
    let beside = match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => "@executable_path",
        Ok("linux") => "$ORIGIN",
        _ => return,
    };
    if built {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{beside}");
    }
}
