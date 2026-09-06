//! Native project-font text shaping and CPU compositing.
//!
//! cosmic-text provides Unicode bidi, script itemization, OpenType shaping,
//! combining-mark handling, emoji clusters, and system fallback. Project font
//! bytes are supplied by `PreparedScene`; this module performs no I/O.

use cosmic_text::{
    Align, Attrs, Buffer, Color, Family, FontSystem, Metrics, Shaping, Style, SwashCache, Weight,
    Wrap,
};

use crate::output::VideoFrame;
use crate::scene::{
    PreparedAutoFit, PreparedScene, PreparedText, PreparedTextAlign, PreparedTextStyle,
    PreparedTextVerticalAlign,
};

pub struct NativeTextRenderer {
    font_system: FontSystem,
    swash_cache: SwashCache,
    loaded_revision: String,
}

impl NativeTextRenderer {
    pub fn new() -> Self {
        Self {
            font_system: FontSystem::new(),
            swash_cache: SwashCache::new(),
            loaded_revision: String::new(),
        }
    }

    pub fn composite(&mut self, frame: &mut VideoFrame, scene: &PreparedScene) {
        self.composite_texts(frame, scene, &scene.texts);
    }

    /// Same, but from an explicit text list rather than the scene's own.
    ///
    /// The render engine samples animation per frame and composites patched text geometry.
    /// Fonts still come from the scene, and `sync_fonts` remains keyed on its revision, so a
    /// moving caption does not reload a font file every frame.
    pub fn composite_texts(
        &mut self,
        frame: &mut VideoFrame,
        scene: &PreparedScene,
        texts: &[PreparedText],
    ) {
        self.sync_fonts(scene);
        for text in texts {
            self.composite_text(frame, scene, text);
        }
    }

    fn sync_fonts(&mut self, scene: &PreparedScene) {
        if self.loaded_revision == scene.revision {
            return;
        }
        self.font_system = FontSystem::new();
        self.swash_cache = SwashCache::new();
        for font in &scene.fonts {
            self.font_system.db_mut().load_font_data(font.bytes.clone());
        }
        self.loaded_revision.clone_from(&scene.revision);
    }

    fn composite_text(
        &mut self,
        frame: &mut VideoFrame,
        scene: &PreparedScene,
        text: &PreparedText,
    ) {
        let global_x = frame.width as f32 / scene.canvas_width.max(1.0);
        let global_y = frame.height as f32 / scene.canvas_height.max(1.0);
        let object_x = text.scale_x * global_x;
        let object_y = text.scale_y * global_y;
        let raster_scale = ((object_x.abs() + object_y.abs()) * 0.5).max(0.01);
        let (layout_width, layout_height) = if text.vertical {
            (
                (text.height * object_y.abs()).max(1.0),
                (text.width * object_x.abs()).max(1.0),
            )
        } else {
            (
                (text.width * object_x.abs()).max(1.0),
                (text.height * object_y.abs()).max(1.0),
            )
        };
        let metrics = Metrics::new(
            (text.font_size * raster_scale).max(1.0),
            (text.line_height * raster_scale).max(1.0),
        );
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        let style = match text.style {
            PreparedTextStyle::Italic => Style::Italic,
            PreparedTextStyle::Oblique => Style::Oblique,
            PreparedTextStyle::Normal => Style::Normal,
        };
        let attrs = Attrs::new()
            .family(Family::Name(&text.family))
            .weight(Weight(text.weight))
            .style(style)
            .letter_spacing(text.letter_spacing / text.font_size.max(1.0));
        let mut borrowed = buffer.borrow_with(&mut self.font_system);
        borrowed.set_wrap(if text.wrap {
            Wrap::WordOrGlyph
        } else {
            Wrap::None
        });
        borrowed.set_size(Some(layout_width), Some(layout_height));
        borrowed.set_text(&text.text, &attrs, Shaping::Advanced);
        let align = match text.align {
            PreparedTextAlign::Center => Align::Center,
            PreparedTextAlign::Right => Align::Right,
            PreparedTextAlign::Left => Align::Left,
        };
        for line in &mut borrowed.lines {
            line.set_align(Some(align));
        }
        borrowed.shape_until_scroll(false);
        let (measured_width, mut measured_height) =
            borrowed
                .layout_runs()
                .fold((0.0_f32, 0.0_f32), |size, run| {
                    (
                        size.0.max(run.line_w),
                        size.1.max(run.line_top + run.line_height),
                    )
                });
        if text.auto_fit != PreparedAutoFit::None {
            if measured_width > 0.0 && measured_height > 0.0 {
                let ratio = (layout_width / measured_width).min(layout_height / measured_height);
                let scale = if text.auto_fit == PreparedAutoFit::Shrink {
                    ratio.min(1.0)
                } else {
                    ratio
                };
                if scale.is_finite() && scale > 0.0 && (scale - 1.0).abs() > 0.001 {
                    borrowed.set_metrics(Metrics::new(
                        metrics.font_size * scale,
                        metrics.line_height * scale,
                    ));
                    borrowed.shape_until_scroll(false);
                    measured_height = borrowed
                        .layout_runs()
                        .map(|run| run.line_top + run.line_height)
                        .fold(0.0_f32, f32::max);
                }
            }
        }

        let vertical_offset = if text.vertical {
            0.0
        } else {
            match text.vertical_align {
                PreparedTextVerticalAlign::Middle => (layout_height - measured_height) * 0.5,
                PreparedTextVerticalAlign::Bottom => layout_height - measured_height,
                PreparedTextVerticalAlign::Top => 0.0,
            }
            .max(0.0)
        };

        let origin_x = text.x * global_x;
        let origin_y = text.y * global_y + vertical_offset;
        let pivot_x = text.anchor_x * object_x.abs();
        let pivot_y = text.anchor_y * object_y.abs();
        let radians = text.rotation_degrees.to_radians();
        let (sin, cos) = radians.sin_cos();
        let object_alpha = text.color_rgba[3] as f32 / 255.0;
        let default_color = Color::rgba(
            text.color_rgba[0],
            text.color_rgba[1],
            text.color_rgba[2],
            text.color_rgba[3],
        );

        borrowed.draw(&mut self.swash_cache, default_color, |x, y, _, _, color| {
            let (mut local_x, mut local_y) = (x as f32, y as f32);
            if text.vertical {
                // Keep the complete shaped run intact. This is intentionally a
                // whole-run rotation, never per-character positioning.
                (local_x, local_y) = (layout_height - local_y, local_x);
            }
            local_x -= pivot_x;
            local_y -= pivot_y;
            let output_x = (origin_x + local_x * cos - local_y * sin).round() as i32;
            let output_y = (origin_y + local_x * sin + local_y * cos).round() as i32;
            blend_bgra_pixel(frame, output_x, output_y, color, object_alpha);
        });
    }
}

fn blend_bgra_pixel(frame: &mut VideoFrame, x: i32, y: i32, color: Color, object_alpha: f32) {
    if x < 0 || y < 0 || x >= frame.width as i32 || y >= frame.height as i32 {
        return;
    }
    let index = ((y as u32 * frame.width + x as u32) * 4) as usize;
    let source_alpha = (color.a() as f32 / 255.0 * object_alpha).clamp(0.0, 1.0);
    let inverse = 1.0 - source_alpha;
    let source = [color.b(), color.g(), color.r()];
    for channel in 0..3 {
        frame.data[index + channel] = (source[channel] as f32 * source_alpha
            + frame.data[index + channel] as f32 * inverse)
            .round()
            .clamp(0.0, 255.0) as u8;
    }
    frame.data[index + 3] = (source_alpha * 255.0 + frame.data[index + 3] as f32 * inverse)
        .round()
        .clamp(0.0, 255.0) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_composites_bgra_in_place() {
        let pool = crate::output::VideoFramePool::new(1, 4).unwrap();
        let mut frame = VideoFrame {
            width: 1,
            height: 1,
            data: pool.try_acquire().unwrap(),
            frame_index: 0,
        };
        blend_bgra_pixel(&mut frame, 0, 0, Color::rgba(255, 0, 0, 128), 1.0);
        assert_eq!(frame.data.as_slice(), [0, 0, 128, 128]);
    }
}
