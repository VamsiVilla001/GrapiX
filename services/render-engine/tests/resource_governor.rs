use grapix_render_engine::capabilities::{
    BlendClass, DrawBatch, DrawPacket, DrawPacketArena, OwnedBytes, ResourceBudget,
    ResourceGovernor, ResourcePriority, ScenePreparationEstimate, VideoFramePool,
};

fn gpu(bytes: u64) -> OwnedBytes {
    OwnedBytes {
        textures_and_mips: bytes,
        ..OwnedBytes::default()
    }
}

fn estimate(bytes: u64, priority: ResourcePriority) -> ScenePreparationEstimate {
    ScenePreparationEstimate {
        owned: gpu(bytes),
        priority,
    }
}

#[test]
fn reservation_evicts_only_unreferenced_warm_lru_then_commits_measured_bytes() {
    let mut governor = ResourceGovernor::new(ResourceBudget {
        cpu_bytes: 1_000,
        gpu_bytes: 100,
        resident_scene_target: 50,
    });

    let first = governor
        .reserve("warm-old", estimate(40, ResourcePriority::Warm))
        .unwrap();
    governor.uploaded(first.reservation).unwrap();
    governor
        .commit(first.reservation, gpu(40), false, 10)
        .unwrap();

    let second = governor
        .reserve("warm-new", estimate(40, ResourcePriority::Warm))
        .unwrap();
    governor.uploaded(second.reservation).unwrap();
    governor
        .commit(second.reservation, gpu(40), false, 20)
        .unwrap();

    let program = governor
        .reserve("program", estimate(50, ResourcePriority::Program))
        .unwrap();
    assert_eq!(program.evicted, vec!["warm-old"]);
    governor.uploaded(program.reservation).unwrap();
    governor
        .commit(program.reservation, gpu(50), true, 30)
        .unwrap();
    assert_eq!(governor.committed().gpu_bytes(), 90);
}

#[test]
fn program_never_evicts_and_failed_prepare_rolls_back_reservation() {
    let mut governor = ResourceGovernor::new(ResourceBudget {
        cpu_bytes: 1_000,
        gpu_bytes: 100,
        resident_scene_target: 50,
    });
    let program = governor
        .reserve("program", estimate(80, ResourcePriority::Program))
        .unwrap();
    governor.uploaded(program.reservation).unwrap();
    governor
        .commit(program.reservation, gpu(80), true, 1)
        .unwrap();

    let blocked = governor.reserve("warm", estimate(30, ResourcePriority::Warm));
    assert!(blocked.is_err());

    let retry = governor
        .reserve("replacement", estimate(20, ResourcePriority::Program))
        .unwrap();
    governor.rollback(retry.reservation);
    assert_eq!(governor.reserved().total_bytes(), 0);
    assert_eq!(governor.committed().gpu_bytes(), 80);
}

#[test]
fn packet_arena_preserves_transparent_painter_order_and_requires_opaque_proof() {
    let mut arena = DrawPacketArena::with_capacity(4);
    for (order, material, blend, proven) in [
        (0, 7, BlendClass::PremultipliedAlpha, false),
        (1, 2, BlendClass::PremultipliedAlpha, false),
        (2, 9, BlendClass::Opaque, false),
    ] {
        arena
            .push(DrawPacket {
                pipeline_id: 1,
                material_id: material,
                texture_id: material,
                geometry_id: material,
                scissor_id: 0,
                painter_order: order,
                blend,
                opaque_reorder_proven: proven,
            })
            .unwrap();
    }
    assert!(!arena.sort_proven_opaque_partition(2, 3));

    let mut batches = [DrawBatch {
        first_packet: 0,
        packet_count: 0,
        pipeline_id: 0,
        material_id: 0,
        texture_id: 0,
        geometry_id: 0,
        scissor_id: 0,
        blend: BlendClass::Opaque,
    }; 4];
    let count = arena.batches_into(&mut batches).unwrap();
    assert_eq!(count, 3);
    assert_eq!(arena.packets()[0].painter_order, 0);
    assert_eq!(arena.packets()[1].painter_order, 1);
}

#[test]
fn video_frame_pool_reuses_preallocated_slots_without_growing() {
    let mut pool = VideoFramePool::new(4, 2, 2);
    let bytes = pool.bytes();
    let a = pool.acquire().unwrap();
    let b = pool.acquire().unwrap();
    assert!(pool.acquire().is_none());
    pool.frame_mut(a).unwrap().frame_index = 99;
    assert!(pool.release(a));
    assert_eq!(pool.acquire(), Some(a));
    assert_eq!(pool.bytes(), bytes);
    assert!(pool.release(b));
}
