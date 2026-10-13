//! The character definition the player animates: poses, eye positions and palette.
//! It ships inside the binary so every app that embeds Jet draws the same character.

use std::collections::BTreeMap;

use serde::Deserialize;

const RIG_JSON: &str = include_str!("jet.json");

/// Every pose is the same closed path: ten anchors, each stored as
/// point, outgoing handle, incoming handle.
pub const ANCHORS: usize = 10;
const NUMBERS_PER_ANCHOR: usize = 6;
const NUMBERS_PER_POSE: usize = ANCHORS * NUMBERS_PER_ANCHOR;

/// Poses the player cannot work without.
const REQUIRED_POSES: [&str; 2] = ["circle", "soft"];

#[derive(Debug, Deserialize)]
pub struct Rig {
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "Parsed so that a rig file without it is rejected. Nothing in Rust reads it yet."
        )
    )]
    pub version: u32,
    #[expect(
        dead_code,
        reason = "Parsed so that a rig file without it is rejected. Nothing in Rust reads it yet."
    )]
    pub unit: f64,
    #[expect(
        dead_code,
        reason = "Parsed so that a rig file without it is rejected. Nothing in Rust reads it yet."
    )]
    pub stroke: f64,
    pub poses: BTreeMap<String, Vec<f64>>,
    pub eyes: BTreeMap<String, [f64; 4]>,
    pub palette: BTreeMap<String, [u8; 3]>,
}

#[derive(Debug, thiserror::Error)]
pub enum RigError {
    #[error("the embedded rig is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),
    #[error("pose {name} has {found} numbers, every pose needs {expected}")]
    PoseSize {
        name: String,
        found: usize,
        expected: usize,
    },
    #[error("the rig has no {name} pose")]
    MissingPose { name: &'static str },
    #[error("eyes are placed for {name}, but there is no such pose")]
    EyesWithoutPose { name: String },
    #[error("the palette has no rest colour")]
    MissingRestColour,
}

impl Rig {
    /// Parses and checks the definition compiled into the binary.
    pub fn embedded() -> Result<Rig, RigError> {
        let rig: Rig = serde_json::from_str(RIG_JSON)?;
        rig.check()?;
        Ok(rig)
    }

    fn check(&self) -> Result<(), RigError> {
        for name in REQUIRED_POSES {
            if !self.poses.contains_key(name) {
                return Err(RigError::MissingPose { name });
            }
        }
        for (name, numbers) in &self.poses {
            if numbers.len() != NUMBERS_PER_POSE {
                return Err(RigError::PoseSize {
                    name: name.clone(),
                    found: numbers.len(),
                    expected: NUMBERS_PER_POSE,
                });
            }
        }
        for name in self.eyes.keys() {
            if !self.poses.contains_key(name) {
                return Err(RigError::EyesWithoutPose { name: name.clone() });
            }
        }
        if !self.palette.contains_key("rest") {
            return Err(RigError::MissingRestColour);
        }
        Ok(())
    }
}

/// Hands the raw definition to the window. The frontend parses it itself,
/// so there is one copy of the character and no second schema to keep in step.
#[tauri::command]
pub fn rig() -> &'static str {
    RIG_JSON
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Poses with this prefix are airborne: Jet is rolling or flying, so the foot
    /// anchor is not on the ground. Every other pose keeps its foot planted.
    const AIRBORNE_PREFIX: &str = "zoom";

    #[test]
    fn embedded_rig_is_complete() {
        let rig = Rig::embedded().expect("embedded rig parses and checks");
        assert_eq!(rig.version, 1);
        assert!(rig.poses.len() >= 15, "expected the full pose set");
        assert!(rig.eyes.contains_key("peak"));
        assert_eq!(rig.palette["rest"], [255, 106, 61]);
    }

    #[test]
    fn every_grounded_pose_shares_the_foot() {
        let rig = Rig::embedded().expect("embedded rig parses and checks");
        let foot_index = 5 * NUMBERS_PER_ANCHOR;
        let mut grounded = 0;
        for (name, numbers) in &rig.poses {
            if name.starts_with(AIRBORNE_PREFIX) {
                continue;
            }
            grounded += 1;
            assert_eq!(numbers[foot_index], 50.0, "{name} moved its foot sideways");
            assert_eq!(numbers[foot_index + 1], 88.0, "{name} lifted its foot");
        }
        assert!(grounded >= 15, "most poses stand on the ground");
    }

    #[test]
    fn airborne_poses_never_sink_below_the_ground() {
        let rig = Rig::embedded().expect("embedded rig parses and checks");
        for (name, numbers) in &rig.poses {
            if !name.starts_with(AIRBORNE_PREFIX) {
                continue;
            }
            let lowest = (0..ANCHORS)
                .map(|i| numbers[i * NUMBERS_PER_ANCHOR + 1])
                .fold(f64::MIN, f64::max);
            assert!(
                lowest <= 88.5,
                "{name} dips below the ground line at {lowest}"
            );
        }
    }

    #[test]
    fn wrong_pose_size_is_reported() {
        let rig = Rig {
            version: 1,
            unit: 100.0,
            stroke: 12.0,
            poses: BTreeMap::from([
                ("circle".to_string(), vec![0.0; NUMBERS_PER_POSE]),
                ("soft".to_string(), vec![0.0; 7]),
            ]),
            eyes: BTreeMap::new(),
            palette: BTreeMap::from([("rest".to_string(), [0, 0, 0])]),
        };
        let error = rig.check().expect_err("short pose must fail");
        assert!(matches!(error, RigError::PoseSize { found: 7, .. }));
    }
}
