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

use std::io::Write;

use Kind::{Corner, Given, Smooth};

type Point = (f64, f64);

/// A handle of this length, as a fraction of the radius, makes a cubic Bézier curve
/// follow a quarter circle.
const KAPPA: f64 = 0.5523;
/// This is the body's centre at rest. The foot sits straight below it.
const CENTRE: Point = (50.0, 56.0);
const FOOT: Point = (50.0, 88.0);
/// This is half the mitten's width, before the stroke is added.
const HAND_WIDTH: f64 = 7.0;
/// Anchors at these screen angles, in degrees, give the circle its ten points. The
/// first one is the head.
const CIRCLE_ANGLES: [f64; 10] = [
    -90.0, -45.0, 0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0, 225.0,
];

/// Says how the handles of one anchor are found.
#[derive(Debug, Clone, Copy, PartialEq)]
enum Kind {
    /// The handles follow the line between the two neighbouring anchors (the
    /// Catmull-Rom rule), so the curve passes smoothly through the anchor.
    Smooth,
    /// The handles run along the anchor's own edges, which leaves a sharp corner.
    Corner,
    /// Both handles are given outright.
    Given { incoming: Point, outgoing: Point },
}

fn norm(v: Point) -> Point {
    let length = v.0.hypot(v.1);
    (v.0 / length, v.1 / length)
}

fn add(a: Point, b: Point, scale: f64) -> Point {
    (a.0 + b.0 * scale, a.1 + b.1 * scale)
}

fn sub(a: Point, b: Point) -> Point {
    (a.0 - b.0, a.1 - b.1)
}

/// Gives a point along the edge from `a` to `b`. The edge is pushed outward from the
/// body by `bow` at its middle.
fn edge_point(a: Point, b: Point, t: f64, bow: f64) -> Point {
    let p = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
    let d = norm(sub(b, a));
    let mut n = (d.1, -d.0);
    let mid = ((a.0 + b.0) / 2.0, (a.1 + b.1) / 2.0);
    if n.0 * (mid.0 - CENTRE.0) + n.1 * (mid.1 - CENTRE.1) < 0.0 {
        n = (-n.0, -n.1);
    }
    add(p, n, bow * 4.0 * t * (1.0 - t))
}

fn round_to_tenth(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// An anchor's incoming handle is the end handle of the segment before it.
fn pose_numbers(segments: &[(Point, Point, Point)]) -> Vec<f64> {
    let n = segments.len();
    let mut values = Vec::with_capacity(n * 6);
    for (i, &(p0, c1, _)) in segments.iter().enumerate() {
        let incoming = segments[(i + n - 1) % n].2;
        values.extend([p0.0, p0.1, c1.0, c1.1, incoming.0, incoming.1]);
    }
    values.into_iter().map(round_to_tenth).collect()
}

/// Turns the anchors into the numbers of a pose. Each anchor's `Kind` says where its
/// handles come from.
fn build(anchors: &[(Point, Kind)]) -> Vec<f64> {
    let n = anchors.len();
    let mut segments = Vec::with_capacity(n);
    for (i, &(p0, k0)) in anchors.iter().enumerate() {
        let (p1, k1) = anchors[(i + 1) % n];
        let before = anchors[(i + n - 1) % n].0;
        let after = anchors[(i + 2) % n].0;
        let c1 = match k0 {
            Given { outgoing, .. } => outgoing,
            Corner => add(p0, sub(p1, p0), 1.0 / 3.0),
            Smooth => add(p0, sub(p1, before), 1.0 / 6.0),
        };
        let c2 = match k1 {
            Given { incoming, .. } => incoming,
            Corner => add(p1, sub(p1, p0), -1.0 / 3.0),
            Smooth => add(p1, sub(after, p0), -1.0 / 6.0),
        };
        segments.push((p0, c1, c2));
    }
    pose_numbers(&segments)
}

fn circle(cx: f64, cy: f64, r: f64) -> Vec<f64> {
    let mut segments = Vec::with_capacity(CIRCLE_ANGLES.len());
    for (i, a_deg) in CIRCLE_ANGLES.iter().enumerate() {
        let a = a_deg.to_radians();
        let mut b = CIRCLE_ANGLES[(i + 1) % CIRCLE_ANGLES.len()].to_radians();
        if b <= a {
            b += 2.0 * std::f64::consts::PI;
        }
        let k = 4.0 / 3.0 * ((b - a) / 4.0).tan() * r;
        let p0 = (cx + r * a.cos(), cy + r * a.sin());
        let p3 = (cx + r * b.cos(), cy + r * b.sin());
        let t0 = (-a.sin(), a.cos());
        let t3 = (-b.sin(), b.cos());
        segments.push((p0, add(p0, t0, k), add(p3, t3, -k)));
    }
    pose_numbers(&segments)
}

fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<f64> {
    let points: Vec<_> = CIRCLE_ANGLES
        .iter()
        .map(|a| {
            let a = a.to_radians();
            ((cx + rx * a.cos(), cy + ry * a.sin()), Smooth)
        })
        .collect();
    build(&points)
}

/// Makes an ellipse whose long axis is turned by `tilt_deg` (screen degrees, negative
/// lifts the right end). It is used for the zoom, where Jet rolls as a ball stretched
/// along its direction of travel.
fn tilted_ellipse(cx: f64, cy: f64, rx: f64, ry: f64, tilt_deg: f64) -> Vec<f64> {
    let t = tilt_deg.to_radians();
    let c = t.cos();
    let s = t.sin();
    let points: Vec<_> = CIRCLE_ANGLES
        .iter()
        .map(|a| {
            let a = a.to_radians();
            let x = rx * a.cos();
            let y = ry * a.sin();
            ((cx + x * c - y * s, cy + x * s + y * c), Smooth)
        })
        .collect();
    build(&points)
}

/// Gives the screen position of a point given in the tilted body's own frame, for
/// placing eyes on a rolling pose.
fn on_body(cx: f64, cy: f64, tilt_deg: f64, local_x: f64, local_y: f64) -> [f64; 2] {
    let t = tilt_deg.to_radians();
    [
        round_to_tenth(cx + local_x * t.cos() - local_y * t.sin()),
        round_to_tenth(cy + local_x * t.sin() + local_y * t.cos()),
    ]
}

/// Makes a standing body. `bows` is the outward bulge of the NE, SE, SW and NW edges.
fn diamond(
    head: Point,
    hand_r: Point,
    hand_l: Point,
    bows: [f64; 4],
    left_hand: Kind,
    head_kind: Kind,
) -> Vec<f64> {
    let [ne, se, sw, nw] = bows;
    build(&[
        (head, head_kind),
        (edge_point(head, hand_r, 0.5, ne), Smooth),
        (hand_r, Corner),
        (edge_point(hand_r, FOOT, 1.0 / 3.0, se), Smooth),
        (edge_point(hand_r, FOOT, 2.0 / 3.0, se), Smooth),
        (FOOT, Corner),
        (edge_point(FOOT, hand_l, 1.0 / 3.0, sw), Smooth),
        (edge_point(FOOT, hand_l, 2.0 / 3.0, sw), Smooth),
        (hand_l, left_hand),
        (edge_point(hand_l, head, 0.5, nw), Smooth),
    ])
}

/// Makes a standing body whose right corner is the base of a raised arm. The arm's
/// centre line leaves `arm_base` at `angle_deg` (screen degrees, negative is up).
fn armed(
    head: Point,
    arm_base: Point,
    hand_l: Point,
    bows: [f64; 4],
    angle_deg: f64,
    length: f64,
    width: f64,
) -> Vec<f64> {
    let [ne, se, sw, nw] = bows;
    let a = angle_deg.to_radians();
    let u = (a.cos(), a.sin());
    // This points to the top side of the arm.
    let n = (u.1, -u.0);
    let hand_centre = add(arm_base, u, length);
    let tip = add(hand_centre, u, width);
    let tip_in = add(tip, n, KAPPA * width);
    let tip_out = add(tip, n, -KAPPA * width);
    let shoulder = edge_point(head, arm_base, 0.78, ne);
    let shoulder_dir = norm(add(norm(sub(arm_base, head)), u, 1.0));
    let from_head = sub(shoulder, head);
    let shoulder_in = add(
        shoulder,
        shoulder_dir,
        -0.3 * from_head.0.hypot(from_head.1),
    );
    let shoulder_out = add(shoulder, shoulder_dir, 0.4 * length);
    let armpit = edge_point(arm_base, FOOT, 0.22, se);
    let hip = edge_point(arm_base, FOOT, 0.62, se);
    let armpit_in = add(armpit, u, 0.38 * length);
    let to_hip = sub(hip, armpit);
    let armpit_out = add(armpit, norm(to_hip), 0.3 * to_hip.0.hypot(to_hip.1));
    build(&[
        (head, Corner),
        (
            shoulder,
            Given {
                incoming: shoulder_in,
                outgoing: shoulder_out,
            },
        ),
        (
            tip,
            Given {
                incoming: tip_in,
                outgoing: tip_out,
            },
        ),
        (
            armpit,
            Given {
                incoming: armpit_in,
                outgoing: armpit_out,
            },
        ),
        (hip, Smooth),
        (FOOT, Corner),
        (edge_point(FOOT, hand_l, 1.0 / 3.0, sw), Smooth),
        (edge_point(FOOT, hand_l, 2.0 / 3.0, sw), Smooth),
        (hand_l, Smooth),
        (edge_point(hand_l, head, 0.5, nw), Smooth),
    ])
}

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
        // Zooming: Jet rolls as a ball stretched along its direction of travel (to the right).
        // These are airborne poses. Their lowest point sits on or near the ground, not on the foot anchor.
        ("zoom_crouch", tilted_ellipse(47.0, 66.5, 36.0, 20.0, 14.0)),
        ("zoom_launch", tilted_ellipse(58.0, 64.0, 46.0, 19.0, -8.0)),
        ("zoom", tilted_ellipse(52.0, 60.0, 38.0, 27.0, -18.0)),
        ("zoom_bob", tilted_ellipse(52.0, 58.0, 39.0, 26.0, -20.0)),
        ("zoom_brake", tilted_ellipse(55.0, 52.5, 27.0, 36.0, 12.0)),
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
        ("zoom", [on_body(52.0, 60.0, -18.0, 9.0, -9.0), on_body(52.0, 60.0, -18.0, 21.0, -7.0)].concat()),
        ("zoom_bob", [on_body(52.0, 58.0, -20.0, 9.0, -9.0), on_body(52.0, 58.0, -20.0, 21.0, -7.0)].concat()),
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
