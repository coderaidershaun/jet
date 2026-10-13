"""Generates src/jet.json: every pose of the rig, constructed rather than drawn.

Run from crates/jet:

    python3 tools/poses.py > src/jet.json

A pose is one closed path of ten anchors. Each anchor is stored as its point, its
outgoing handle and its incoming handle, so every pose has the same sixty numbers
and any two poses blend. The anchors in order:

    0 head   1 shoulder R   2 hand R   3 armpit R   4 hip R
    5 foot   6 hip L        7 armpit L 8 hand L     9 shoulder L

In the circle and the diamond the shoulders, armpits and hips "sleep" on the edges.
An arm pose wakes the right-hand four into a limb. The foot never moves.
"""

import json
import math

KAPPA = 0.5523  # handle length that makes a cubic follow a quarter circle
CENTRE = (50, 56)  # body centre at rest; the foot sits at (50, 88)
FOOT = (50, 88)
HAND_WIDTH = 7  # half the mitten's width before the stroke is added

# anchors at these screen angles give the circle its ten points; 0 is the head
CIRCLE_ANGLES = [-90, -45, 0, 30, 60, 90, 120, 150, 180, 225]


def norm(v):
    length = math.hypot(*v)
    return (v[0] / length, v[1] / length)


def add(a, b, scale=1.0):
    return (a[0] + b[0] * scale, a[1] + b[1] * scale)


def sub(a, b):
    return (a[0] - b[0], a[1] - b[1])


def edge_point(a, b, t, bow):
    """A point along the edge a->b, pushed outward from the body by `bow` at the middle."""
    p = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    d = norm(sub(b, a))
    n = (d[1], -d[0])
    mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
    if n[0] * (mid[0] - CENTRE[0]) + n[1] * (mid[1] - CENTRE[1]) < 0:
        n = (-n[0], -n[1])
    return add(p, n, bow * 4 * t * (1 - t))


def build(anchors):
    """anchors: list of (point, kind). kind is 's' smooth, 'c' corner, or
    ('d', incoming_handle, outgoing_handle) when the handles are given outright.
    Smooth anchors get Catmull-Rom handles; corners get handles along their edges."""
    n = len(anchors)
    segments = []
    for i in range(n):
        p0, k0 = anchors[i]
        p1, k1 = anchors[(i + 1) % n]
        before = anchors[(i - 1) % n][0]
        after = anchors[(i + 2) % n][0]
        if isinstance(k0, tuple):
            c1 = k0[2]
        elif k0 == 'c':
            c1 = add(p0, sub(p1, p0), 1 / 3)
        else:
            c1 = add(p0, sub(p1, before), 1 / 6)
        if isinstance(k1, tuple):
            c2 = k1[1]
        elif k1 == 'c':
            c2 = add(p1, sub(p1, p0), -1 / 3)
        else:
            c2 = add(p1, sub(after, p0), -1 / 6)
        segments.append((p0, c1, c2, p1))
    numbers = []
    for i in range(n):
        p0, c1, _, _ = segments[i]
        incoming = segments[(i - 1) % n][2]
        numbers += [p0[0], p0[1], c1[0], c1[1], incoming[0], incoming[1]]
    return [round(v, 1) for v in numbers]


def circle(cx, cy, r):
    segments = []
    for i, a_deg in enumerate(CIRCLE_ANGLES):
        a = math.radians(a_deg)
        b = math.radians(CIRCLE_ANGLES[(i + 1) % len(CIRCLE_ANGLES)])
        if b <= a:
            b += 2 * math.pi
        k = 4 / 3 * math.tan((b - a) / 4) * r
        p0 = (cx + r * math.cos(a), cy + r * math.sin(a))
        p3 = (cx + r * math.cos(b), cy + r * math.sin(b))
        t0 = (-math.sin(a), math.cos(a))
        t3 = (-math.sin(b), math.cos(b))
        segments.append((p0, add(p0, t0, k), add(p3, t3, -k), p3))
    numbers = []
    for i in range(len(segments)):
        p0, c1, _, _ = segments[i]
        incoming = segments[(i - 1) % len(segments)][2]
        numbers += [p0[0], p0[1], c1[0], c1[1], incoming[0], incoming[1]]
    return [round(v, 1) for v in numbers]


def ellipse(cx, cy, rx, ry):
    return build([((cx + rx * math.cos(math.radians(a)), cy + ry * math.sin(math.radians(a))), 's') for a in CIRCLE_ANGLES])


def tilted_ellipse(cx, cy, rx, ry, tilt_deg):
    """An ellipse whose long axis is turned by tilt_deg (screen degrees, negative lifts the right end).
    Used for the zoom, where Jet rolls as a ball stretched along its direction of travel."""
    t = math.radians(tilt_deg)
    c, s = math.cos(t), math.sin(t)
    points = []
    for a in CIRCLE_ANGLES:
        x = rx * math.cos(math.radians(a))
        y = ry * math.sin(math.radians(a))
        points.append(((cx + x * c - y * s, cy + x * s + y * c), 's'))
    return build(points)


def on_body(cx, cy, tilt_deg, local_x, local_y):
    """A point given in the tilted body's own frame, for placing eyes on a rolling pose."""
    t = math.radians(tilt_deg)
    return [round(cx + local_x * math.cos(t) - local_y * math.sin(t), 1), round(cy + local_x * math.sin(t) + local_y * math.cos(t), 1)]


def diamond(head, hand_r, hand_l, bows=(3, 3, 3, 3), left_hand='c', head_kind='c'):
    """A standing body. bows = outward bulge of the NE, SE, SW, NW edges."""
    ne, se, sw, nw = bows
    return build([
        (head, head_kind),
        (edge_point(head, hand_r, 0.5, ne), 's'),
        (hand_r, 'c'),
        (edge_point(hand_r, FOOT, 1 / 3, se), 's'),
        (edge_point(hand_r, FOOT, 2 / 3, se), 's'),
        (FOOT, 'c'),
        (edge_point(FOOT, hand_l, 1 / 3, sw), 's'),
        (edge_point(FOOT, hand_l, 2 / 3, sw), 's'),
        (hand_l, left_hand),
        (edge_point(hand_l, head, 0.5, nw), 's'),
    ])


def armed(head, arm_base, hand_l, bows, angle_deg, length, width=HAND_WIDTH):
    """A standing body whose right corner is the base of a raised arm.
    The arm's centre line leaves `arm_base` at `angle_deg` (screen degrees, negative is up)."""
    ne, se, sw, nw = bows
    a = math.radians(angle_deg)
    u = (math.cos(a), math.sin(a))
    n = (u[1], -u[0])  # the top side of the arm
    hand_centre = add(arm_base, u, length)
    tip = add(hand_centre, u, width)
    tip_in = add(tip, n, KAPPA * width)
    tip_out = add(tip, n, -KAPPA * width)
    shoulder = edge_point(head, arm_base, 0.78, ne)
    shoulder_dir = norm(add(norm(sub(arm_base, head)), u))
    shoulder_in = add(shoulder, shoulder_dir, -0.3 * math.hypot(*sub(shoulder, head)))
    shoulder_out = add(shoulder, shoulder_dir, 0.4 * length)
    armpit = edge_point(arm_base, FOOT, 0.22, se)
    hip = edge_point(arm_base, FOOT, 0.62, se)
    armpit_in = add(armpit, u, 0.38 * length)
    armpit_out = add(armpit, norm(sub(hip, armpit)), 0.3 * math.hypot(*sub(hip, armpit)))
    return build([
        (head, 'c'),
        (shoulder, ('d', shoulder_in, shoulder_out)),
        (tip, ('d', tip_in, tip_out)),
        (armpit, ('d', armpit_in, armpit_out)),
        (hip, 's'),
        (FOOT, 'c'),
        (edge_point(FOOT, hand_l, 1 / 3, sw), 's'),
        (edge_point(FOOT, hand_l, 2 / 3, sw), 's'),
        (hand_l, 's'),
        (edge_point(hand_l, head, 0.5, nw), 's'),
    ])


POSES = {
    'circle': circle(50, 56, 32),
    'squash': ellipse(50, 64, 38, 24),
    'stretch': ellipse(50, 51, 26, 37),
    'land': diamond((50, 30), (86, 58), (14, 58), bows=(3.5, 3.5, 3.5, 3.5)),
    'soft': diamond((50, 24), (82, 56), (18, 56)),
    'dip': diamond((47, 26), (85, 60), (18, 56), bows=(2.5, 3, 3, 3)),
    'swing': armed((53, 18), (80, 36), (18, 52), (2, 4, 5, 4), -12, 22),
    'peak': armed((56, 10), (78, 24), (18, 46), (2, 4, 7, 6), -62, 26),
    'out': armed((56, 11), (79, 25), (18, 47), (2, 4, 7, 6), -32, 27),
    'downlag': armed((52, 18), (80, 38), (18, 52), (2, 4, 5, 4), -22, 22),
    'tuck': diamond((50, 24), (80, 58), (18, 56), bows=(2, 3, 3, 3)),
    'relax': diamond((50, 30), (82, 60), (18, 60), bows=(7, 6, 6, 7), left_hand='s', head_kind='s'),
    'puddle': ellipse(50, 60, 35, 28),
    'rebound': ellipse(50, 54, 30, 34),
    'bow': diamond((66, 36), (82, 60), (24, 58), bows=(5, 5, 6, 7), left_hand='s'),
    # zooming: Jet rolls as a ball stretched along its direction of travel (to the right).
    # These are airborne poses; their lowest point sits on or near the ground, not the foot anchor.
    'zoom_crouch': tilted_ellipse(47, 66.5, 36, 20, 14),
    'zoom_launch': tilted_ellipse(58, 64, 46, 19, -8),
    'zoom': tilted_ellipse(52, 60, 38, 27, -18),
    'zoom_bob': tilted_ellipse(52, 58, 39, 26, -20),
    'zoom_brake': tilted_ellipse(55, 52.5, 27, 36, 12),
}

# where the eyes sit for the poses that may show a face: left x, y, right x, y
EYES = {
    'circle': [42, 54, 58, 54],
    'land': [42, 54, 58, 54],
    'soft': [42, 52, 58, 52],
    'dip': [39, 53, 55, 53],
    'swing': [45, 46, 61, 46],
    'peak': [47, 40, 63, 40],
    'out': [47, 41, 63, 41],
    'downlag': [44, 46, 60, 46],
    'tuck': [42, 52, 58, 52],
    'bow': [50, 56, 64, 54],
    'zoom': on_body(52, 60, -18, 9, -9) + on_body(52, 60, -18, 21, -7),
    'zoom_bob': on_body(52, 58, -20, 9, -9) + on_body(52, 58, -20, 21, -7),
}

PALETTE = {
    'rest': [255, 106, 61],
    'warm': [255, 176, 32],
    'cool': [91, 140, 255],
    'muted': [107, 107, 115],
    'alert': [255, 61, 61],
}


def number(v):
    return str(int(v)) if float(v).is_integer() else str(v)


def main():
    lines = ['{', '  "version": 1,', '  "unit": 100,', '  "stroke": 12,', '  "join": "round",', '  "foot": [50, 88],', '  "poses": {']
    names = list(POSES)
    for i, name in enumerate(names):
        lines.append('    "%s": [%s]%s' % (name, ', '.join(number(v) for v in POSES[name]), ',' if i < len(names) - 1 else ''))
    lines += ['  },', '  "eyes": {']
    names = list(EYES)
    for i, name in enumerate(names):
        lines.append('    "%s": [%s]%s' % (name, ', '.join(number(v) for v in EYES[name]), ',' if i < len(names) - 1 else ''))
    lines += ['  },', '  "palette": {']
    names = list(PALETTE)
    for i, name in enumerate(names):
        lines.append('    "%s": [%s]%s' % (name, ', '.join(str(v) for v in PALETTE[name]), ',' if i < len(names) - 1 else ''))
    lines += ['  }', '}']
    text = '\n'.join(lines) + '\n'
    json.loads(text)
    print(text, end='')


if __name__ == '__main__':
    main()
