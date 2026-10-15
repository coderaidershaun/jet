//! Reads a picture of the quanty library for the page, as a `data:` address, because the page
//! may not open files itself.

use std::io;
use std::path::{Path, PathBuf};

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;

/// The largest picture the page is sent.
const MAX_BYTES: u64 = 8 * 1024 * 1024;

/// Why a picture could not be sent to the page.
#[derive(Debug, thiserror::Error)]
pub(super) enum ImageError {
    #[error("no quanty folder is set, so its pictures cannot be found")]
    NoLibrary,
    #[error("the quanty folder {path} cannot be opened: {source}")]
    Library {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("the picture {path} cannot be found: {source}")]
    Missing {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{path} is outside the quanty folder")]
    Outside { path: PathBuf },
    #[error("{path} is not a PNG or JPEG file")]
    NotAPicture { path: PathBuf },
    #[error("{path} is {bytes} bytes; pictures over 8 MB are not shown")]
    TooLarge { path: PathBuf, bytes: u64 },
    #[error("could not read {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
}

/// The picture at `path` as a `data:` address. A relative path is read from `library`. The file
/// must be inside `library` once links are followed, end in .png, .jpg or .jpeg, and be at most
/// 8 MB.
///
/// # Errors
/// [`ImageError::NoLibrary`] when no folder is set, [`ImageError::Library`] when it cannot be
/// opened, [`ImageError::Missing`] when the picture is not there, [`ImageError::Outside`] when
/// it lies outside the folder, [`ImageError::NotAPicture`] for another kind of file,
/// [`ImageError::TooLarge`] over 8 MB, and [`ImageError::Read`] when reading fails.
pub(super) fn read_data_uri(library: Option<&Path>, path: &str) -> Result<String, ImageError> {
    let library = library.ok_or(ImageError::NoLibrary)?;
    let root = library
        .canonicalize()
        .map_err(|source| ImageError::Library {
            path: library.to_path_buf(),
            source,
        })?;
    // An absolute `path` replaces the root in `join`, so the check below must catch it.
    let wanted = root.join(path);
    let found = wanted
        .canonicalize()
        .map_err(|source| ImageError::Missing {
            path: wanted.clone(),
            source,
        })?;
    if !found.starts_with(&root) {
        return Err(ImageError::Outside { path: found });
    }
    let Some(mime) = mime_of(&found) else {
        return Err(ImageError::NotAPicture { path: found });
    };
    let read_error = |source| ImageError::Read {
        path: found.clone(),
        source,
    };
    let metadata = std::fs::metadata(&found).map_err(read_error)?;
    if !metadata.is_file() {
        return Err(ImageError::NotAPicture { path: found });
    }
    if metadata.len() > MAX_BYTES {
        return Err(ImageError::TooLarge {
            path: found,
            bytes: metadata.len(),
        });
    }
    let bytes = std::fs::read(&found).map_err(read_error)?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

fn mime_of(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use base64::Engine as _;
    use base64::engine::general_purpose::STANDARD;

    use super::*;

    /// A folder of its own with an empty `library/` inside; `outside.png` goes beside the library.
    fn scratch(name: &str) -> PathBuf {
        let folder = std::env::temp_dir().join(format!("jet-image-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&folder);
        fs::create_dir_all(folder.join("library")).unwrap();
        folder
    }

    fn decoded(address: &str, mime: &str) -> Vec<u8> {
        let prefix = format!("data:{mime};base64,");
        let body = address
            .strip_prefix(&prefix)
            .unwrap_or_else(|| panic!("{address} does not start with {prefix}"));
        STANDARD.decode(body).unwrap()
    }

    #[test]
    fn a_picture_in_the_library_comes_back_as_a_data_address() {
        let folder = scratch("reads");
        let library = folder.join("library");
        fs::create_dir_all(library.join("content")).unwrap();
        let png = [0x89, b'P', b'N', b'G', 0, 1, 2, 254, 255];
        let jpeg = [0xFF, 0xD8, 0xFF, 0xE0, 7, 8, 9];
        fs::write(library.join("content/a.png"), png).unwrap();
        fs::write(library.join("shot.JPG"), jpeg).unwrap();
        fs::write(library.join("shot.jpeg"), jpeg).unwrap();

        let relative = read_data_uri(Some(&library), "content/a.png").unwrap();
        assert_eq!(decoded(&relative, "image/png"), png);
        let absolute = read_data_uri(
            Some(&library),
            library.join("content/a.png").to_str().unwrap(),
        )
        .unwrap();
        assert_eq!(
            absolute, relative,
            "the temp folder is behind a link on macOS, which must not matter"
        );
        let upper = read_data_uri(Some(&library), "shot.JPG").unwrap();
        assert_eq!(decoded(&upper, "image/jpeg"), jpeg);
        let long = read_data_uri(Some(&library), "shot.jpeg").unwrap();
        assert_eq!(long, upper);

        fs::remove_dir_all(folder).unwrap();
    }

    #[test]
    fn pictures_outside_the_library_of_another_kind_or_too_large_are_refused() {
        let folder = scratch("refuses");
        let library = folder.join("library");
        let outside = folder.join("outside.png");
        fs::write(&outside, [1, 2, 3]).unwrap();
        fs::write(library.join("notes.gif"), b"GIF89a").unwrap();
        fs::create_dir(library.join("dir.png")).unwrap();
        let big = fs::File::create(library.join("big.png")).unwrap();
        big.set_len(MAX_BYTES + 1).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&outside, library.join("link.png")).unwrap();
        let read = |path: &str| read_data_uri(Some(&library), path);

        assert!(matches!(
            read_data_uri(None, "a.png"),
            Err(ImageError::NoLibrary)
        ));
        let no_folder = folder.join("nowhere");
        assert!(matches!(
            read_data_uri(Some(&no_folder), "a.png"),
            Err(ImageError::Library { .. })
        ));
        assert!(matches!(
            read("../outside.png"),
            Err(ImageError::Outside { .. })
        ));
        assert!(matches!(
            read(outside.to_str().unwrap()),
            Err(ImageError::Outside { .. })
        ));
        #[cfg(unix)]
        assert!(
            matches!(read("link.png"), Err(ImageError::Outside { .. })),
            "a link that points out of the folder is refused"
        );
        assert!(matches!(
            read("notes.gif"),
            Err(ImageError::NotAPicture { .. })
        ));
        assert!(matches!(
            read("dir.png"),
            Err(ImageError::NotAPicture { .. })
        ));
        assert!(
            matches!(read("big.png"), Err(ImageError::TooLarge { bytes, .. }) if bytes == MAX_BYTES + 1)
        );
        assert!(matches!(
            read("nothing.png"),
            Err(ImageError::Missing { .. })
        ));

        fs::remove_dir_all(folder).unwrap();
    }
}
