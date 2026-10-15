//! Generates `rig/jet.json`: every pose of the rig, constructed rather than drawn.
//!
//! Run from `crates/jet`:
//!
//! ```sh
//! cargo run -p jet --example poses > rig/jet.json
//! ```
//!
//! `cargo test` fails when that file and this generator are out of step.
//!
//! A pose is one closed path of ten anchors. Each anchor is stored as its point, its
//! outgoing handle and its incoming handle, so every pose has the same sixty numbers
//! and any two poses blend. The anchors are in this order:
//!
//! ```text
//! 0 head   1 shoulder R   2 hand R   3 armpit R   4 hip R
//! 5 foot   6 hip L        7 armpit L 8 hand L     9 shoulder L
//! ```
//!
//! In the circle and the diamond the shoulders, armpits and hips "sleep" on the edges.
//! An arm pose wakes the right-hand four into a limb. The foot never moves, unless the
//! pose is airborne.
//!
//! The table in this file holds the decisions for each pose. The `shape` module turns them
//! into numbers.

mod shape;

use std::io::Write;

use shape::Kind::{Corner, Smooth};
use shape::{FOOT, armed, circle, diamond, ellipse, on_body, tilted_ellipse};

/// This is half the mitten's width, before the stroke is added.
const HAND_WIDTH: f64 = 7.0;

// Each pose stays on one line, so that the table reads as a list of decisions.
#[rustfmt::skip]
fn poses() -> Vec<(&'static str, Vec<f64>)> {
    vec![
        ("circle", circle(50.0, 56.0, 32.0)),
        ("squash", ellipse(50.0, 64.0, 38.0, 24.0)),
        ("stretch", ellipse(50.0, 51.0, 26.0, 37.0)),
        ("land", diamond((50.0, 30.0), (86.0, 58.0), (14.0, 58.0), [3.5; 4], Corner, Corner)),
        ("soft", diamond((50.0, 24.0), (82.0, 56.0), (18.0, 56.0), [3.0; 4], Corner, Corner)),
        ("dip", diamond((47.0, 26.0), (85.0, 60.0), (18.0, 56.0), [2.5, 3.0, 3.0, 3.0], Corner, Corner)),
        ("swing", armed((53.0, 18.0), (80.0, 36.0), (18.0, 52.0), [2.0, 4.0, 5.0, 4.0], -12.0, 22.0, HAND_WIDTH)),
        ("peak", armed((56.0, 10.0), (78.0, 24.0), (18.0, 46.0), [2.0, 4.0, 7.0, 6.0], -62.0, 26.0, HAND_WIDTH)),
        ("out", armed((56.0, 11.0), (79.0, 25.0), (18.0, 47.0), [2.0, 4.0, 7.0, 6.0], -32.0, 27.0, HAND_WIDTH)),
        ("downlag", armed((52.0, 18.0), (80.0, 38.0), (18.0, 52.0), [2.0, 4.0, 5.0, 4.0], -22.0, 22.0, HAND_WIDTH)),
        ("tuck", diamond((50.0, 24.0), (80.0, 58.0), (18.0, 56.0), [2.0, 3.0, 3.0, 3.0], Corner, Corner)),
        ("relax", diamond((50.0, 30.0), (82.0, 60.0), (18.0, 60.0), [7.0, 6.0, 6.0, 7.0], Smooth, Smooth)),
        ("puddle", ellipse(50.0, 60.0, 35.0, 28.0)),
        ("rebound", ellipse(50.0, 54.0, 30.0, 34.0)),
        ("bow", diamond((66.0, 36.0), (82.0, 60.0), (24.0, 58.0), [5.0, 5.0, 6.0, 7.0], Smooth, Corner)),
        ("pip", circle(50.0, 83.0, 5.0)),
        ("ponder", diamond((44.0, 20.0), (80.0, 54.0), (16.0, 54.0), [4.1, 3.7, 3.9, 3.6], Corner, Corner)),
        ("glare", diamond((54.0, 32.0), (86.0, 60.0), (16.0, 60.0), [3.5, 3.7, 3.6, 3.8], Corner, Corner)),
        ("lean", diamond((60.0, 26.0), (86.0, 58.0), (20.0, 58.0), [3.4, 3.8, 3.4, 4.2], Corner, Corner)),
        // Zooming: Jet rolls as a ball stretched along its direction of travel (to the right).
        // These are airborne poses. Their lowest point sits on or near the ground, not on the foot anchor.
        ("zoom_crouch", tilted_ellipse(47.0, 66.5, 36.0, 20.0, 14.0)),
        ("zoom_launch", tilted_ellipse(58.0, 64.0, 46.0, 19.0, -8.0)),
        ("zoom", tilted_ellipse(52.0, 60.0, 38.0, 27.0, -18.0)),
        ("zoom_bob", tilted_ellipse(52.0, 58.0, 39.0, 26.0, -20.0)),
        ("zoom_brake", tilted_ellipse(55.0, 52.5, 27.0, 36.0, 12.0)),
        ("zoom_hop", ellipse(50.0, 46.0, 26.0, 34.0)),
        ("peer", diamond((57.0, 12.0), (76.0, 50.0), (28.0, 52.0), [3.6, 4.0, 3.6, 4.4], Corner, Corner)),
        ("doze", diamond((43.0, 36.0), (84.0, 64.0), (17.0, 62.0), [6.0, 5.0, 5.5, 7.0], Smooth, Smooth)),
        // Falling and dangling: Jet drops under an umbrella or hangs from a rope while the host moves it down.
        ("zoom_fall", tilted_ellipse(50.0, 52.0, 24.0, 35.0, -6.0)),
        ("zoom_dangle", tilted_ellipse(50.0, 53.0, 25.0, 35.0, 10.0)),
        ("salute", armed((56.0, 22.0), (70.0, 27.0), (18.0, 56.0), [2.0, 4.0, 5.0, 4.0], 38.0, 22.0, HAND_WIDTH)),
    ]
}

/// Says where the eyes sit for the poses that may show a face: left x, y, right x, y.
// Each row stays on one line, so that the table reads as a list.
#[rustfmt::skip]
fn eyes() -> Vec<(&'static str, Vec<f64>)> {
    vec![
        ("circle", vec![42.0, 54.0, 58.0, 54.0]),
        ("land", vec![42.0, 54.0, 58.0, 54.0]),
        ("soft", vec![42.0, 52.0, 58.0, 52.0]),
        ("dip", vec![39.0, 53.0, 55.0, 53.0]),
        ("swing", vec![45.0, 46.0, 61.0, 46.0]),
        ("peak", vec![47.0, 40.0, 63.0, 40.0]),
        ("out", vec![47.0, 41.0, 63.0, 41.0]),
        ("downlag", vec![44.0, 46.0, 60.0, 46.0]),
        ("tuck", vec![42.0, 52.0, 58.0, 52.0]),
        ("bow", vec![50.0, 56.0, 64.0, 54.0]),
        ("ponder", vec![36.0, 38.0, 50.0, 36.0]),
        ("glare", vec![45.0, 48.0, 61.0, 48.0]),
        ("lean", vec![50.0, 46.0, 66.0, 46.0]),
        ("zoom_hop", vec![42.0, 36.0, 58.0, 36.0]),
        ("zoom", [on_body(52.0, 60.0, -18.0, 9.0, -9.0), on_body(52.0, 60.0, -18.0, 21.0, -7.0)].concat()),
        ("zoom_bob", [on_body(52.0, 58.0, -20.0, 9.0, -9.0), on_body(52.0, 58.0, -20.0, 21.0, -7.0)].concat()),
        ("peer", vec![50.0, 31.0, 63.0, 31.0]),
        ("doze", vec![35.0, 51.0, 50.0, 49.0]),
        ("zoom_fall", [on_body(50.0, 52.0, -6.0, -8.0, -14.0), on_body(50.0, 52.0, -6.0, 8.0, -14.0)].concat()),
        ("zoom_dangle", [on_body(50.0, 53.0, 10.0, -8.0, -14.0), on_body(50.0, 53.0, 10.0, 8.0, -14.0)].concat()),
        ("salute", vec![48.0, 44.0, 64.0, 44.0]),
        ("squash", vec![40.5, 62.5, 59.5, 62.5]),
    ]
}

/// Each named colour is given as red, green and blue.
const PALETTE: [(&str, [u8; 3]); 5] = [
    ("rest", [255, 106, 61]),
    ("warm", [255, 176, 32]),
    ("cool", [91, 140, 255]),
    ("muted", [107, 107, 115]),
    ("alert", [255, 61, 61]),
];

/// Whole numbers print without a decimal point, and negative zero prints as `0`. The
/// rest print in the shortest form that reads back as the same number.
fn number(v: f64) -> String {
    if v.fract() == 0.0 {
        (v as i64).to_string()
    } else {
        v.to_string()
    }
}

fn numbers_as_text(values: &[f64]) -> Vec<String> {
    values.iter().map(|&v| number(v)).collect()
}

fn rows(table: &[(&str, Vec<String>)]) -> Vec<String> {
    table
        .iter()
        .enumerate()
        .map(|(i, (name, values))| {
            let comma = if i + 1 < table.len() { "," } else { "" };
            format!("    \"{name}\": [{}]{comma}", values.join(", "))
        })
        .collect()
}

fn rig_json() -> String {
    let poses: Vec<_> = poses()
        .iter()
        .map(|(name, values)| (*name, numbers_as_text(values)))
        .collect();
    let eyes: Vec<_> = eyes()
        .iter()
        .map(|(name, values)| (*name, numbers_as_text(values)))
        .collect();
    let palette: Vec<_> = PALETTE
        .iter()
        .map(|(name, rgb)| (*name, rgb.iter().map(u8::to_string).collect()))
        .collect();

    let mut lines = Vec::new();
    lines.extend(
        [
            "{",
            r#"  "version": 1,"#,
            r#"  "unit": 100,"#,
            r#"  "stroke": 12,"#,
            r#"  "join": "round","#,
        ]
        .map(String::from),
    );
    lines.push(format!(
        r#"  "foot": [{}, {}],"#,
        number(FOOT.0),
        number(FOOT.1)
    ));
    lines.push(String::from(r#"  "poses": {"#));
    lines.extend(rows(&poses));
    lines.extend(["  },", r#"  "eyes": {"#].map(String::from));
    lines.extend(rows(&eyes));
    lines.extend(["  },", r#"  "palette": {"#].map(String::from));
    lines.extend(rows(&palette));
    lines.extend(["  }", "}"].map(String::from));
    lines.join("\n") + "\n"
}

fn main() -> std::io::Result<()> {
    std::io::stdout().write_all(rig_json().as_bytes())
}

#[cfg(test)]
mod tests {
    use super::rig_json;

    #[test]
    fn generator_prints_the_committed_rig() {
        let committed = include_str!("jet.json");
        let generated = rig_json();

        for (index, (generated_line, committed_line)) in
            generated.lines().zip(committed.lines()).enumerate()
        {
            assert_eq!(
                generated_line,
                committed_line,
                "line {} of the generated rig (left) differs from rig/jet.json (right); \
                 if the change is wanted, write the file again with \
                 `cargo run -p jet --example poses > rig/jet.json` from crates/jet",
                index + 1
            );
        }
        assert_eq!(
            generated.lines().count(),
            committed.lines().count(),
            "the generated rig and rig/jet.json have a different number of lines"
        );
        assert!(
            generated == committed,
            "every line matches, but the line endings or the last newline differ"
        );
    }
}
