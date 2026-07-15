//! Off-screen render target and GPU->CPU frame readback.
//!
//! Readback path: render into a BGRA8-sRGB texture, copy to a mapped-readable
//! staging buffer (rows padded to wgpu's 256-byte COPY_BYTES_PER_ROW_ALIGNMENT),
//! then unpad into a tightly packed `Vec<u8>` for the video output. The
//! staging buffer is reused across frames; only the tight copy allocates.

use crate::output::VideoFrame;
use crate::renderer::pipeline::{QuadPipeline, QuadUniforms, RENDER_FORMAT};

pub struct FrameTarget {
    width: u32,
    height: u32,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    readback_buffer: wgpu::Buffer,
    padded_bytes_per_row: u32,
}

/// Rows in copy operations must align to 256 bytes (wgpu constraint).
pub fn padded_bytes_per_row(width: u32) -> u32 {
    let tight = width * 4;
    tight.div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT
}

impl FrameTarget {
    pub fn new(device: &wgpu::Device, width: u32, height: u32) -> Self {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("grapix-offscreen-target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: RENDER_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });

        let padded = padded_bytes_per_row(width);
        let readback_buffer = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("grapix-frame-readback"),
            size: u64::from(padded) * u64::from(height),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });

        Self {
            width,
            height,
            view: texture.create_view(&wgpu::TextureViewDescriptor::default()),
            texture,
            readback_buffer,
            padded_bytes_per_row: padded,
        }
    }

    /// Render one frame and read it back. Blocking: waits for the GPU, which
    /// is the intended behavior on the dedicated render thread (the frame
    /// clock accounts for it; WebSocket handling runs elsewhere).
    pub fn render_and_read_back(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        pipeline: &QuadPipeline,
        quads: &[QuadUniforms],
        frame_index: u64,
    ) -> anyhow::Result<VideoFrame> {
        pipeline.upload(queue, quads);

        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("grapix-frame-encoder"),
        });

        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("grapix-composite-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &self.view,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        // Transparent black; the scene background is drawn as
                        // a quad, matching the editor.
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            pipeline.draw(&mut pass, quads);
        }

        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &self.texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &self.readback_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(self.padded_bytes_per_row),
                    rows_per_image: Some(self.height),
                },
            },
            wgpu::Extent3d {
                width: self.width,
                height: self.height,
                depth_or_array_layers: 1,
            },
        );

        queue.submit(Some(encoder.finish()));

        let slice = self.readback_buffer.slice(..);
        let (sender, receiver) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });

        device.poll(wgpu::PollType::Wait)?;
        receiver
            .recv()
            .map_err(|_| anyhow::anyhow!("frame readback callback dropped"))??;

        let tight_row = (self.width * 4) as usize;
        let mut data = vec![0u8; tight_row * self.height as usize];
        {
            let mapped = slice.get_mapped_range();
            for row in 0..self.height as usize {
                let src = row * self.padded_bytes_per_row as usize;
                data[row * tight_row..(row + 1) * tight_row]
                    .copy_from_slice(&mapped[src..src + tight_row]);
            }
        }
        self.readback_buffer.unmap();

        Ok(VideoFrame {
            width: self.width,
            height: self.height,
            data,
            frame_index,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_padding_aligns_to_256() {
        assert_eq!(padded_bytes_per_row(1920), 7680); // already aligned
        assert_eq!(padded_bytes_per_row(1280), 5120); // already aligned
        assert_eq!(padded_bytes_per_row(100), 512); // 400 -> 512
        assert_eq!(padded_bytes_per_row(64), 256); // 256 exactly
        assert_eq!(padded_bytes_per_row(63), 256); // 252 -> 256
    }
}
