//! Pictures: their pixel size, and the picture as one JPEG small enough for the model.

use std::io::Cursor;

use base64::Engine;
use image::{DynamicImage, ExtendedColorType, ImageReader, Limits, RgbImage, imageops::FilterType};

use super::{ReadError, Reading};

/// The longest side of a picture handed to the model.
const PICTURE_SIDE: u32 = 1568;
const PICTURE_QUALITY: u8 = 85;
const MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DECODE_SIDE: u32 = 16_384;

/// A reader of the picture that refuses one too large to decode. The same limits apply when a
/// picture is described, so an upload that could never be read is refused when it arrives.
fn reader(bytes: &[u8]) -> Result<ImageReader<Cursor<&[u8]>>, ReadError> {
    let mut limits = Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    limits.max_image_width = Some(MAX_DECODE_SIDE);
    limits.max_image_height = Some(MAX_DECODE_SIDE);
    let mut reader = ImageReader::new(Cursor::new(bytes)).with_guessed_format()?;
    reader.limits(limits);
    Ok(reader)
}

/// `1600 × 900 px`, from the header alone.
pub(super) fn describe(bytes: &[u8]) -> Result<String, ReadError> {
    let (width, height) = reader(bytes)?.into_dimensions()?;
    Ok(format!("{width} × {height} px"))
}

pub(super) fn read(bytes: &[u8]) -> Result<Reading, ReadError> {
    let picture = reader(bytes)?.decode()?;
    let (width, height) = (picture.width(), picture.height());
    let fitted = if width.max(height) > PICTURE_SIDE {
        picture.resize(PICTURE_SIDE, PICTURE_SIDE, FilterType::Triangle)
    } else {
        picture
    };
    let flat = on_white(&fitted);
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, PICTURE_QUALITY)
        .encode(
            flat.as_raw(),
            flat.width(),
            flat.height(),
            ExtendedColorType::Rgb8,
        )
        .map_err(ReadError::Encode)?;
    Ok(Reading::Image {
        data: base64::engine::general_purpose::STANDARD.encode(jpeg),
        width,
        height,
    })
}

/// The picture with any see-through part laid over white, because a JPEG has no transparency.
fn on_white(picture: &DynamicImage) -> RgbImage {
    let rgba = picture.to_rgba8();
    let mut flat = RgbImage::new(rgba.width(), rgba.height());
    for (x, y, pixel) in rgba.enumerate_pixels() {
        let alpha = u32::from(pixel[3]);
        let over_white =
            |channel: u8| ((u32::from(channel) * alpha + 255 * (255 - alpha) + 127) / 255) as u8;
        flat.put_pixel(
            x,
            y,
            image::Rgb([
                over_white(pixel[0]),
                over_white(pixel[1]),
                over_white(pixel[2]),
            ]),
        );
    }
    flat
}
