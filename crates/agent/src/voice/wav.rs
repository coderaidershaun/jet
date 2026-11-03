//! The 44-byte header that turns raw 16-bit mono audio into a WAV file, so that Google reads the
//! sample rate and the length from the clip itself instead of guessing them.

const HEADER_BYTES: usize = 44;

/// `pcm` (16-bit little-endian mono samples at `rate`) with a RIFF/WAVE header in front.
pub(super) fn with_header(pcm: &[u8], rate: u32) -> Vec<u8> {
    let length = u32::try_from(pcm.len()).unwrap_or(u32::MAX);
    let mut wav = Vec::with_capacity(HEADER_BYTES + pcm.len());
    wav.extend_from_slice(b"RIFF");
    wav.extend_from_slice(&length.saturating_add(36).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt ");
    wav.extend_from_slice(&16u32.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&1u16.to_le_bytes());
    wav.extend_from_slice(&rate.to_le_bytes());
    wav.extend_from_slice(&(rate * 2).to_le_bytes());
    wav.extend_from_slice(&2u16.to_le_bytes());
    wav.extend_from_slice(&16u16.to_le_bytes());
    wav.extend_from_slice(b"data");
    wav.extend_from_slice(&length.to_le_bytes());
    wav.extend_from_slice(pcm);
    wav
}
