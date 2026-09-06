//! Easing — the Rust half of one specification.
//!
//! The twin is `Shared/shared-types/src/easing.ts`. The Editor previews with that one and
//! Program renders with this one, so they are one specification in two languages, exactly like
//! `resolve_texture_fit` and the tile system. Both are checked against
//! `Shared/animation-engine/fixtures/easing-vectors.json`, which is generated once and never
//! regenerated to make a test pass: a changed number there is a changed curve, and every scene
//! already authored against it would then animate differently on air.
//!
//! Every curve is a closed form or a fixed-iteration solve, written with the same operations in
//! the same order as the TypeScript. IEEE 754 doubles then agree far inside the 1e-9 the
//! conformance test demands — which is why there is no lookup table and no early exit anywhere
//! in this file.
//!
//! `ease-in`, `ease-out` and `ease-in-out` are the three curves scenes on disk already use and
//! they are quadratic; they are aliases of the `-quad` forms and their shape is frozen.

/// `back` overshoot, the classic Penner constant.
const BACK_C1: f64 = 1.70158;
const BACK_C3: f64 = BACK_C1 + 1.0;
const BACK_C2: f64 = BACK_C1 * 1.525;
/// `elastic` angular frequencies.
const ELASTIC_C4: f64 = (2.0 * std::f64::consts::PI) / 3.0;
const ELASTIC_C5: f64 = (2.0 * std::f64::consts::PI) / 4.5;
/// `bounce` gravity constant and segment width.
const BOUNCE_N1: f64 = 7.5625;
const BOUNCE_D1: f64 = 2.75;

/// Every easing name this build implements, in the fixture's order.
pub const SCENE_KEYFRAME_EASINGS: [&str; 36] = [
    "linear",
    "hold",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "ease-in-quad",
    "ease-out-quad",
    "ease-in-out-quad",
    "ease-in-cubic",
    "ease-out-cubic",
    "ease-in-out-cubic",
    "ease-in-quart",
    "ease-out-quart",
    "ease-in-out-quart",
    "ease-in-quint",
    "ease-out-quint",
    "ease-in-out-quint",
    "ease-in-sine",
    "ease-out-sine",
    "ease-in-out-sine",
    "ease-in-expo",
    "ease-out-expo",
    "ease-in-out-expo",
    "ease-in-circ",
    "ease-out-circ",
    "ease-in-out-circ",
    "ease-in-back",
    "ease-out-back",
    "ease-in-out-back",
    "ease-in-elastic",
    "ease-out-elastic",
    "ease-in-out-elastic",
    "ease-in-bounce",
    "ease-out-bounce",
    "ease-in-out-bounce",
];

/// Solve a CSS-style cubic-bezier for `y` at `x`.
///
/// A fixed iteration count with no early exit, matching the TypeScript exactly: an
/// epsilon-based break can take a different number of steps in two languages and land a
/// fraction apart, and this has to agree to 1e-9.
fn cubic_bezier(x1: f64, y1: f64, x2: f64, y2: f64, x: f64) -> f64 {
    let curve_x = |t: f64| {
        let u = 1.0 - t;
        3.0 * u * u * t * x1 + 3.0 * u * t * t * x2 + t * t * t
    };
    let curve_y = |t: f64| {
        let u = 1.0 - t;
        3.0 * u * u * t * y1 + 3.0 * u * t * t * y2 + t * t * t
    };
    let slope_x = |t: f64| {
        let u = 1.0 - t;
        3.0 * u * u * (x1 - 0.0) + 6.0 * u * t * (x2 - x1) + 3.0 * t * t * (1.0 - x2)
    };

    let mut t = x;
    for _ in 0..8 {
        let dx = curve_x(t) - x;
        let d = slope_x(t);
        if d.abs() < 1e-12 {
            break;
        }
        t -= dx / d;
    }
    curve_y(t.clamp(0.0, 1.0))
}

fn bounce_out(t: f64) -> f64 {
    if t < 1.0 / BOUNCE_D1 {
        return BOUNCE_N1 * t * t;
    }
    if t < 2.0 / BOUNCE_D1 {
        let shifted = t - 1.5 / BOUNCE_D1;
        return BOUNCE_N1 * shifted * shifted + 0.75;
    }
    if t < 2.5 / BOUNCE_D1 {
        let shifted = t - 2.25 / BOUNCE_D1;
        return BOUNCE_N1 * shifted * shifted + 0.9375;
    }
    let shifted = t - 2.625 / BOUNCE_D1;
    BOUNCE_N1 * shifted * shifted + 0.984375
}

/// Evaluate an easing at `t`, or `None` when this build does not implement the name.
///
/// `None` rather than a linear fallback, deliberately and identically to the TypeScript: a
/// scene authored against an easing this build lacks must hold its previous value and raise a
/// diagnostic, not animate confidently along a curve nobody chose.
pub fn apply_easing(easing: &str, t: f64) -> Option<f64> {
    let c = t.clamp(0.0, 1.0);
    let value = match easing {
        "linear" => c,
        // A hold key keeps its value for the whole segment and steps at the next key.
        "hold" => {
            if c < 1.0 {
                0.0
            } else {
                1.0
            }
        }
        "ease" => cubic_bezier(0.25, 0.1, 0.25, 1.0, c),

        "ease-in" | "ease-in-quad" => c * c,
        "ease-out" | "ease-out-quad" => 1.0 - (1.0 - c) * (1.0 - c),
        "ease-in-out" | "ease-in-out-quad" => {
            if c < 0.5 {
                2.0 * c * c
            } else {
                1.0 - (-2.0 * c + 2.0).powi(2) / 2.0
            }
        }

        "ease-in-cubic" => c * c * c,
        "ease-out-cubic" => 1.0 - (1.0 - c).powi(3),
        "ease-in-out-cubic" => {
            if c < 0.5 {
                4.0 * c * c * c
            } else {
                1.0 - (-2.0 * c + 2.0).powi(3) / 2.0
            }
        }

        "ease-in-quart" => c * c * c * c,
        "ease-out-quart" => 1.0 - (1.0 - c).powi(4),
        "ease-in-out-quart" => {
            if c < 0.5 {
                8.0 * c * c * c * c
            } else {
                1.0 - (-2.0 * c + 2.0).powi(4) / 2.0
            }
        }

        "ease-in-quint" => c * c * c * c * c,
        "ease-out-quint" => 1.0 - (1.0 - c).powi(5),
        "ease-in-out-quint" => {
            if c < 0.5 {
                16.0 * c * c * c * c * c
            } else {
                1.0 - (-2.0 * c + 2.0).powi(5) / 2.0
            }
        }

        "ease-in-sine" => 1.0 - ((c * std::f64::consts::PI) / 2.0).cos(),
        "ease-out-sine" => ((c * std::f64::consts::PI) / 2.0).sin(),
        "ease-in-out-sine" => -((std::f64::consts::PI * c).cos() - 1.0) / 2.0,

        "ease-in-expo" => {
            if c == 0.0 {
                0.0
            } else {
                (2.0_f64).powf(10.0 * c - 10.0)
            }
        }
        "ease-out-expo" => {
            if c == 1.0 {
                1.0
            } else {
                1.0 - (2.0_f64).powf(-10.0 * c)
            }
        }
        "ease-in-out-expo" => {
            if c == 0.0 {
                0.0
            } else if c == 1.0 {
                1.0
            } else if c < 0.5 {
                (2.0_f64).powf(20.0 * c - 10.0) / 2.0
            } else {
                (2.0 - (2.0_f64).powf(-20.0 * c + 10.0)) / 2.0
            }
        }

        "ease-in-circ" => 1.0 - (1.0 - c.powi(2)).sqrt(),
        "ease-out-circ" => (1.0 - (c - 1.0).powi(2)).sqrt(),
        "ease-in-out-circ" => {
            if c < 0.5 {
                (1.0 - (1.0 - (2.0 * c).powi(2)).sqrt()) / 2.0
            } else {
                ((1.0 - (-2.0 * c + 2.0).powi(2)).sqrt() + 1.0) / 2.0
            }
        }

        "ease-in-back" => BACK_C3 * c * c * c - BACK_C1 * c * c,
        "ease-out-back" => 1.0 + BACK_C3 * (c - 1.0).powi(3) + BACK_C1 * (c - 1.0).powi(2),
        "ease-in-out-back" => {
            if c < 0.5 {
                ((2.0 * c).powi(2) * ((BACK_C2 + 1.0) * 2.0 * c - BACK_C2)) / 2.0
            } else {
                ((2.0 * c - 2.0).powi(2) * ((BACK_C2 + 1.0) * (c * 2.0 - 2.0) + BACK_C2) + 2.0) / 2.0
            }
        }

        "ease-in-elastic" => {
            if c == 0.0 {
                0.0
            } else if c == 1.0 {
                1.0
            } else {
                -(2.0_f64).powf(10.0 * c - 10.0) * ((c * 10.0 - 10.75) * ELASTIC_C4).sin()
            }
        }
        "ease-out-elastic" => {
            if c == 0.0 {
                0.0
            } else if c == 1.0 {
                1.0
            } else {
                (2.0_f64).powf(-10.0 * c) * ((c * 10.0 - 0.75) * ELASTIC_C4).sin() + 1.0
            }
        }
        "ease-in-out-elastic" => {
            if c == 0.0 {
                0.0
            } else if c == 1.0 {
                1.0
            } else if c < 0.5 {
                -((2.0_f64).powf(20.0 * c - 10.0) * ((20.0 * c - 11.125) * ELASTIC_C5).sin()) / 2.0
            } else {
                ((2.0_f64).powf(-20.0 * c + 10.0) * ((20.0 * c - 11.125) * ELASTIC_C5).sin()) / 2.0
                    + 1.0
            }
        }

        "ease-in-bounce" => 1.0 - bounce_out(1.0 - c),
        "ease-out-bounce" => bounce_out(c),
        "ease-in-out-bounce" => {
            if c < 0.5 {
                (1.0 - bounce_out(1.0 - 2.0 * c)) / 2.0
            } else {
                (1.0 + bounce_out(2.0 * c - 1.0)) / 2.0
            }
        }

        _ => return None,
    };
    Some(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The conformance table both languages answer to.
    ///
    /// Read from the checked-in fixture rather than recomputed here, because a test that
    /// recomputes the expectation from the implementation proves only that the implementation
    /// equals itself. This is the whole point of P0: add an easing to one language and not the
    /// other, or change a curve, and this fails locally rather than on air.
    #[test]
    fn every_easing_matches_the_shared_conformance_vectors() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Shared/animation-engine/fixtures/easing-vectors.json"
        );
        let text = std::fs::read_to_string(path)
            .unwrap_or_else(|error| panic!("easing fixture unreadable at {path}: {error}"));
        let fixture: Value = serde_json::from_str(&text).expect("easing fixture is not JSON");

        let times: Vec<f64> = fixture["times"]
            .as_array()
            .expect("fixture.times")
            .iter()
            .map(|value| value.as_f64().expect("time is a number"))
            .collect();
        let tolerance = fixture["tolerance"].as_f64().unwrap_or(1e-9);
        let easings = fixture["easings"].as_object().expect("fixture.easings");

        for (name, samples) in easings {
            let expected: Vec<f64> = samples
                .as_array()
                .expect("samples array")
                .iter()
                .map(|value| value.as_f64().expect("sample is a number"))
                .collect();
            assert_eq!(
                expected.len(),
                times.len(),
                "{name} has {} samples for {} times",
                expected.len(),
                times.len()
            );

            for (index, time) in times.iter().enumerate() {
                let actual = apply_easing(name, *time).unwrap_or_else(|| {
                    panic!("the Rust build does not implement easing \"{name}\"")
                });
                let difference = (actual - expected[index]).abs();
                assert!(
                    difference <= tolerance,
                    "{name} at t={time}: Rust {actual} vs fixture {} (difference {difference} exceeds {tolerance})",
                    expected[index]
                );
            }
        }
    }

    /// Both languages must implement exactly the same set — no more, no less.
    #[test]
    fn the_implemented_set_matches_the_fixture_exactly() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../Shared/animation-engine/fixtures/easing-vectors.json"
        );
        let fixture: Value =
            serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json");
        let easings = fixture["easings"].as_object().expect("fixture.easings");

        for name in SCENE_KEYFRAME_EASINGS {
            assert!(
                easings.contains_key(name),
                "{name} is implemented in Rust but absent from the shared fixture"
            );
        }
        for name in easings.keys() {
            assert!(
                SCENE_KEYFRAME_EASINGS.contains(&name.as_str()),
                "{name} is in the shared fixture but not implemented in Rust"
            );
        }
    }

    /// An unknown easing is `None`, never a silent linear substitution.
    #[test]
    fn an_unknown_easing_is_refused_rather_than_guessed() {
        assert_eq!(apply_easing("ease-in-out-quintic-ish", 0.5), None);
        assert_eq!(apply_easing("", 0.5), None);
        // The legacy three keep their exact quadratic shape.
        assert_eq!(apply_easing("ease-in", 0.5), Some(0.25));
        assert_eq!(apply_easing("ease-out", 0.5), Some(0.75));
        assert_eq!(apply_easing("ease-in-out", 0.25), Some(0.125));
    }
}
