//! The geometry that builds a pose: circles, ellipses and standing bodies, each turned
//! into the sixty numbers of a pose. The table of which poses exist, and the numbers
//! chosen for each, lives in the module that calls these.

use Kind::{Corner, Given, Smooth};

type Point = (f64, f64);

/// A handle of this length, as a fraction of the radius, makes a cubic Bézier curve
/// follow a quarter circle.
const KAPPA: f64 = 0.5523;
/// This is the body's centre at rest. The foot sits straight below it.
const CENTRE: Point = (50.0, 56.0);
pub(super) const FOOT: Point = (50.0, 88.0);
/// Anchors at these screen angles, in degrees, give the circle its ten points. The
/// first one is the head.
const CIRCLE_ANGLES: [f64; 10] = [
    -90.0, -45.0, 0.0, 30.0, 60.0, 90.0, 120.0, 150.0, 180.0, 225.0,
];

/// Says how the handles of one anchor are found.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) enum Kind {
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

pub(super) fn circle(cx: f64, cy: f64, r: f64) -> Vec<f64> {
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

pub(super) fn ellipse(cx: f64, cy: f64, rx: f64, ry: f64) -> Vec<f64> {
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
pub(super) fn tilted_ellipse(cx: f64, cy: f64, rx: f64, ry: f64, tilt_deg: f64) -> Vec<f64> {
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
pub(super) fn on_body(cx: f64, cy: f64, tilt_deg: f64, local_x: f64, local_y: f64) -> [f64; 2] {
    let t = tilt_deg.to_radians();
    [
        round_to_tenth(cx + local_x * t.cos() - local_y * t.sin()),
        round_to_tenth(cy + local_x * t.sin() + local_y * t.cos()),
    ]
}

/// Makes a standing body. `bows` is the outward bulge of the NE, SE, SW and NW edges.
pub(super) fn diamond(
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
pub(super) fn armed(
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
