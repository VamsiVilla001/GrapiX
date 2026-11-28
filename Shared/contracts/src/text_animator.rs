//! Range weights for text animators (11.61).
//!
//! Range profiles and seeded shuffling are adapted from EffectCraft
//! at 9a7d3e76991d5372448033b473dc12c2480a6a04, crates/text/src/selectors.rs.
//! Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors.
//! MIT license in services/render-engine/worker/EFFECTCRAFT-LICENSE.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use ts_rs::TS;

#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum TextRangeShape {
    #[default]
    Square,
    RampUp,
    RampDown,
    Triangle,
    Round,
    Smooth,
}

/// The logical units a text range selects.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS, schemars::JsonSchema,
)]
#[serde(rename_all = "camelCase")]
pub enum TextRangeBasis {
    #[default]
    Characters,
    CharactersExcludingSpaces,
    Words,
    Lines,
}

/// Normalized range parameters. One unit of offset spans the entire text.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TextRangeSelector {
    pub start: f64,
    pub end: f64,
    pub offset: f64,
    pub amount: f64,
    pub shape: TextRangeShape,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub basis: Option<TextRangeBasis>,
    pub smoothness: f64,
    pub ease_high: f64,
    pub ease_low: f64,
    pub randomize_order: bool,
}

impl Default for TextRangeSelector {
    fn default() -> Self {
        Self {
            start: 0.0,
            end: 1.0,
            offset: 0.0,
            amount: 1.0,
            shape: TextRangeShape::Square,
            basis: None,
            smoothness: 1.0,
            ease_high: 0.0,
            ease_low: 0.0,
            randomize_order: false,
        }
    }
}

impl TextRangeSelector {
    /// Weights in logical unit order, after optional deterministic randomization.
    /// The caller supplies one count for its chosen character, word, or line unit.
    pub fn weights(&self, unit_count: usize, object_id: &str) -> Result<Vec<f64>, &'static str> {
        self.validate()?;
        let order = self
            .randomize_order
            .then(|| random_order(unit_count, object_id));
        Ok((0..unit_count)
            .map(|index| {
                let position = order.as_ref().map_or(index, |positions| positions[index]);
                self.weight(position, unit_count)
            })
            .collect())
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        for (value, name) in [
            (self.start, "start must be in 0..=1"),
            (self.end, "end must be in 0..=1"),
            (self.smoothness, "smoothness must be in 0..=1"),
        ] {
            if !(0.0..=1.0).contains(&value) {
                return Err(name);
            }
        }
        for (value, name) in [
            (self.amount, "amount must be in -1..=1"),
            (self.ease_high, "easeHigh must be in -1..=1"),
            (self.ease_low, "easeLow must be in -1..=1"),
        ] {
            if !(-1.0..=1.0).contains(&value) {
                return Err(name);
            }
        }
        if !self.offset.is_finite() {
            return Err("offset must be finite");
        }
        Ok(())
    }

    fn weight(&self, index: usize, count: usize) -> f64 {
        // Compute the authored width before adding the signed offset, so an
        // offset far outside the text does not erase a narrow finite range.
        let start = self.start.min(self.end) + self.offset;
        let width = (self.end - self.start).abs();
        let unit = 1.0 / count as f64;
        let centre = (index as f64 + 0.5) * unit;
        let value = if self.shape == TextRangeShape::Square && width > 1e-12 {
            // The two edge distances are measured in units, not as fractions of the text. A
            // unit's centre (index + 0.5) and the ends of a whole range (0 and count) are then
            // exact, so a range that covers the text selects every unit at exactly 1. As
            // fractions, `1 - centre` rounds: the last of 15 units came out at 1 - 2^-53, a glyph
            // at animator opacity 0 kept an alpha of 1e-16, and its colour stayed in the frame.
            let units = count as f64;
            let centre_in_units = index as f64 + 0.5;
            let soft = self.smoothness * unit > 1e-12;
            let edge = |distance: f64| {
                if soft {
                    (distance / self.smoothness + 0.5).clamp(0.0, 1.0)
                } else {
                    f64::from(u8::from(distance >= 0.0))
                }
            };
            edge(centre_in_units - start * units).min(edge((start + width) * units - centre_in_units))
        } else if width <= 1e-12 {
            match self.shape {
                TextRangeShape::RampUp => f64::from(u8::from(centre >= start)),
                TextRangeShape::RampDown => f64::from(u8::from(centre < start)),
                _ => 0.0,
            }
        } else {
            let profile = shape_value(self.shape, (centre - start) / width);
            ease(profile, self.ease_high, self.ease_low)
        };
        value * self.amount
    }
}

/// One geometry animator on a text object. Values describe the transform at
/// full selection; the range weights blend from the identity per cluster.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS, schemars::JsonSchema)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct TextAnimator {
    pub selector: TextRangeSelector,
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    /// Fully selected paint opacity. Absent keeps the original paint alpha.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub opacity: Option<f64>,
    /// Solid target colour for fully selected glyphs.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub fill: Option<crate::color::Rgba>,
    /// Signed spacing added after a fully selected shaped cluster, in scene pixels.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub tracking: Option<f64>,
}

impl Default for TextAnimator {
    fn default() -> Self {
        Self {
            selector: TextRangeSelector::default(),
            x: 0.0,
            y: 0.0,
            scale: 1.0,
            rotation: 0.0,
            opacity: None,
            fill: None,
            tracking: None,
        }
    }
}

impl TextAnimator {
    pub fn validate(&self) -> Result<(), &'static str> {
        self.selector.validate()?;
        if self.tracking.is_some_and(|value| !value.is_finite()) {
            return Err("tracking must be finite");
        }
        if self
            .fill
            .is_some_and(|fill| !crate::animation::colour::valid_rgba(fill))
        {
            return Err("fill requires finite RGB and alpha in 0..=1");
        }
        if self
            .opacity
            .is_some_and(|value| !(0.0..=1.0).contains(&value))
        {
            return Err("opacity must be in 0..=1");
        }
        if ![self.x, self.y, self.scale, self.rotation]
            .into_iter()
            .all(f64::is_finite)
            || self.scale < 0.0
        {
            return Err(
                "geometry requires finite position and rotation and nonnegative finite scale",
            );
        }
        Ok(())
    }
}

pub const ANIMATOR_PROPERTIES: &[&str] = &[
    "textAnimator.selector.start",
    "textAnimator.selector.end",
    "textAnimator.selector.offset",
    "textAnimator.x",
    "textAnimator.y",
    "textAnimator.scale",
    "textAnimator.rotation",
    "textAnimator.opacity",
    "textAnimator.tracking",
];

fn shape_value(shape: TextRangeShape, position: f64) -> f64 {
    match shape {
        TextRangeShape::RampUp => position.clamp(0.0, 1.0),
        TextRangeShape::RampDown => 1.0 - position.clamp(0.0, 1.0),
        _ if !(0.0..=1.0).contains(&position) => 0.0,
        TextRangeShape::Square => 1.0,
        TextRangeShape::Triangle => 1.0 - (2.0 * position - 1.0).abs(),
        TextRangeShape::Round => (1.0 - (2.0 * position - 1.0).powi(2)).max(0.0).sqrt(),
        TextRangeShape::Smooth => {
            let triangle = 1.0 - (2.0 * position - 1.0).abs();
            triangle * triangle * (3.0 - 2.0 * triangle)
        }
    }
}

fn ease(value: f64, high: f64, low: f64) -> f64 {
    if high == 0.0 && low == 0.0 {
        return value;
    }
    let first = (1.0 - low) / 3.0;
    let second = 1.0 - (1.0 - high) / 3.0;
    let remaining = 1.0 - value;
    3.0 * remaining * remaining * value * first
        + 3.0 * remaining * value * value * second
        + value * value * value
}

fn splitmix(mut value: u64) -> u64 {
    value = value.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut mixed = value;
    mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    mixed ^ (mixed >> 31)
}

fn random_order(count: usize, object_id: &str) -> Vec<usize> {
    let hash = Sha256::digest(object_id.as_bytes());
    let seed = u64::from_le_bytes(hash[..8].try_into().expect("SHA-256 has 32 bytes"));
    let mut positions: Vec<_> = (0..count).collect();
    let mut state = splitmix(seed ^ 0x5EED);
    for index in (1..count).rev() {
        state = splitmix(state);
        positions.swap(index, (state % (index as u64 + 1)) as usize);
    }
    positions
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn range_offset_and_shapes_follow_logical_unit_centres() {
        let mut selector = TextRangeSelector {
            end: 0.5,
            offset: 0.25,
            smoothness: 0.0,
            ..Default::default()
        };
        assert_eq!(selector.weights(4, "title").unwrap(), [0.0, 1.0, 1.0, 0.0]);
        selector.offset = 0.0;
        selector.end = 1.0;
        selector.shape = TextRangeShape::RampUp;
        assert_eq!(
            selector.weights(4, "title").unwrap(),
            [0.125, 0.375, 0.625, 0.875]
        );
        selector.shape = TextRangeShape::RampDown;
        assert_eq!(
            selector.weights(4, "title").unwrap(),
            [0.875, 0.625, 0.375, 0.125]
        );
        selector.shape = TextRangeShape::Triangle;
        assert_eq!(
            selector.weights(4, "title").unwrap(),
            [0.25, 0.75, 0.75, 0.25]
        );
        selector.amount = -0.5;
        assert_eq!(
            selector.weights(4, "title").unwrap(),
            [-0.125, -0.375, -0.375, -0.125]
        );
    }

    /// A range that covers the text is "every unit, fully": exactly 1, for any length of text,
    /// soft-edged or hard. Measured as fractions of the text this failed for 241 of the lengths
    /// 1 to 512 (5, 10, 11, 13, 15...): the last unit came out at 1 - 2^-53.
    #[test]
    fn a_range_that_covers_the_text_selects_every_unit_at_exactly_one() {
        for count in 1..=512 {
            for smoothness in [1.0, 0.5, 0.0] {
                let selector = TextRangeSelector { smoothness, ..Default::default() };
                let weights = selector.weights(count, "title").unwrap();
                assert!(
                    weights.iter().all(|weight| *weight == 1.0),
                    "{count} units at smoothness {smoothness}: {:?}",
                    weights.iter().position(|weight| *weight != 1.0)
                );
            }
        }
    }

    /// The soft edge is unchanged by measuring in units: half a unit of cover is half selected.
    #[test]
    fn a_soft_edge_selects_a_unit_by_how_much_of_it_the_range_covers() {
        // 4 units, range 0 to 0.375: unit 0 whole, unit 1 half (the edge is at its centre), 2 and 3 none.
        let selector = TextRangeSelector { end: 0.375, ..Default::default() };
        assert_eq!(selector.weights(4, "title").unwrap(), [1.0, 0.5, 0.0, 0.0]);
        let hard = TextRangeSelector { smoothness: 0.0, ..selector };
        assert_eq!(hard.weights(4, "title").unwrap(), [1.0, 1.0, 0.0, 0.0]);
    }

    #[test]
    fn random_order_is_a_reproducible_per_object_permutation() {
        let mut selector = TextRangeSelector {
            shape: TextRangeShape::RampUp,
            ..Default::default()
        };
        let ordered = selector.weights(32, "title").unwrap();
        selector.randomize_order = true;
        let mut shuffled = selector.weights(32, "title").unwrap();
        assert_eq!(shuffled, selector.weights(32, "title").unwrap());
        assert_ne!(shuffled, selector.weights(32, "subtitle").unwrap());
        shuffled.sort_by(f64::total_cmp);
        assert_eq!(shuffled, ordered);
    }

    #[test]
    fn malformed_parameters_are_named_and_empty_text_is_empty() {
        let mut selector = TextRangeSelector::default();
        assert!(selector.weights(0, "empty").unwrap().is_empty());
        selector.offset = f64::INFINITY;
        assert_eq!(selector.weights(4, "title"), Err("offset must be finite"));
        let encoded = serde_json::to_vec(&TextRangeSelector::default()).unwrap();
        assert_eq!(
            serde_json::from_slice::<TextRangeSelector>(&encoded).unwrap(),
            TextRangeSelector::default()
        );
    }
}
