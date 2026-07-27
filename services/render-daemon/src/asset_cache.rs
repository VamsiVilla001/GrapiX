//! Content-addressed asset catalogue and cache-tier accounting.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum AssetPriority {
    Editor,
    Warm,
    Preview,
    Program,
}

#[derive(Debug, Clone)]
pub struct AssetDescriptor {
    pub asset_id: String,
    pub checksum: String,
    pub disk_bytes: u64,
    pub estimated_decoded_bytes: u64,
    pub estimated_gpu_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCacheStatus {
    pub unique_assets: usize,
    pub aliases: usize,
    pub referenced_assets: usize,
    pub pinned_assets: usize,
    pub disk_bytes: u64,
    pub decoded_cpu_bytes: u64,
    pub gpu_bytes: u64,
    pub cpu_budget_bytes: u64,
    pub gpu_budget_bytes: u64,
}

struct CacheEntry {
    aliases: HashSet<String>,
    scene_references: HashMap<String, AssetPriority>,
    disk_bytes: u64,
    decoded_cpu_bytes: u64,
    gpu_bytes: u64,
    pinned: bool,
    last_used: u64,
}

pub struct AssetCacheManager {
    entries: HashMap<String, CacheEntry>,
    asset_to_checksum: HashMap<String, String>,
    cpu_budget_bytes: u64,
    gpu_budget_bytes: u64,
    clock: u64,
}

impl AssetCacheManager {
    pub fn new(cpu_budget_bytes: u64, gpu_budget_bytes: u64) -> Self {
        Self {
            entries: HashMap::new(),
            asset_to_checksum: HashMap::new(),
            cpu_budget_bytes,
            gpu_budget_bytes,
            clock: 0,
        }
    }

    pub fn sync_scene(
        &mut self,
        scene_id: &str,
        assets: Vec<AssetDescriptor>,
        priority: AssetPriority,
    ) {
        self.release_scene(scene_id);
        for descriptor in assets {
            let asset_id = descriptor.asset_id.clone();
            self.register(descriptor);
            self.reference(scene_id, &asset_id, priority);
        }
        self.evict_unreferenced();
    }

    pub fn register(&mut self, descriptor: AssetDescriptor) {
        self.clock = self.clock.saturating_add(1);
        let checksum = if descriptor.checksum.is_empty() {
            format!("unhashed:{}", descriptor.asset_id)
        } else {
            descriptor.checksum.clone()
        };
        self.asset_to_checksum
            .insert(descriptor.asset_id.clone(), checksum.clone());
        let entry = self.entries.entry(checksum.clone()).or_insert(CacheEntry {
            aliases: HashSet::new(),
            scene_references: HashMap::new(),
            disk_bytes: descriptor.disk_bytes,
            decoded_cpu_bytes: 0,
            gpu_bytes: 0,
            pinned: false,
            last_used: self.clock,
        });
        entry.aliases.insert(descriptor.asset_id);
        entry.disk_bytes = entry.disk_bytes.max(descriptor.disk_bytes);
        entry.last_used = self.clock;
        // Estimates are deliberately not counted as resident bytes. Promotion
        // is explicit so status distinguishes a disk catalogue from a real
        // decoded/GPU allocation.
        let _ = (
            descriptor.estimated_decoded_bytes,
            descriptor.estimated_gpu_bytes,
        );
    }

    pub fn promote(&mut self, asset_id: &str, decoded_cpu_bytes: u64, gpu_bytes: u64) -> bool {
        self.clock = self.clock.saturating_add(1);
        let Some(checksum) = self.asset_to_checksum.get(asset_id) else {
            return false;
        };
        let Some(entry) = self.entries.get_mut(checksum) else {
            return false;
        };
        entry.decoded_cpu_bytes = decoded_cpu_bytes;
        entry.gpu_bytes = gpu_bytes;
        entry.last_used = self.clock;
        self.evict_unreferenced();
        true
    }

    pub fn reference(&mut self, scene_id: &str, asset_id: &str, priority: AssetPriority) {
        self.clock = self.clock.saturating_add(1);
        if let Some(checksum) = self.asset_to_checksum.get(asset_id) {
            if let Some(entry) = self.entries.get_mut(checksum) {
                entry
                    .scene_references
                    .insert(scene_id.to_string(), priority);
                entry.last_used = self.clock;
            }
        }
    }

    pub fn set_scene_priority(&mut self, scene_id: &str, priority: AssetPriority) {
        for entry in self.entries.values_mut() {
            if let Some(current) = entry.scene_references.get_mut(scene_id) {
                *current = priority;
            }
        }
    }

    pub fn release_scene(&mut self, scene_id: &str) {
        for entry in self.entries.values_mut() {
            entry.scene_references.remove(scene_id);
        }
    }

    pub fn set_budgets(&mut self, cpu_budget_bytes: u64, gpu_budget_bytes: u64) {
        self.cpu_budget_bytes = cpu_budget_bytes;
        self.gpu_budget_bytes = gpu_budget_bytes;
        self.evict_unreferenced();
    }

    pub fn status(&self) -> AssetCacheStatus {
        AssetCacheStatus {
            unique_assets: self.entries.len(),
            aliases: self.entries.values().map(|entry| entry.aliases.len()).sum(),
            referenced_assets: self
                .entries
                .values()
                .filter(|entry| !entry.scene_references.is_empty())
                .count(),
            pinned_assets: self.entries.values().filter(|entry| entry.pinned).count(),
            disk_bytes: self.entries.values().map(|entry| entry.disk_bytes).sum(),
            decoded_cpu_bytes: self
                .entries
                .values()
                .map(|entry| entry.decoded_cpu_bytes)
                .sum(),
            gpu_bytes: self.entries.values().map(|entry| entry.gpu_bytes).sum(),
            cpu_budget_bytes: self.cpu_budget_bytes,
            gpu_budget_bytes: self.gpu_budget_bytes,
        }
    }

    fn evict_unreferenced(&mut self) {
        while self.status().decoded_cpu_bytes > self.cpu_budget_bytes
            || self.status().gpu_bytes > self.gpu_budget_bytes
        {
            let candidate = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.scene_references.is_empty() && !entry.pinned)
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(checksum, _)| checksum.clone());
            let Some(checksum) = candidate else {
                break;
            };
            if let Some(entry) = self.entries.get_mut(&checksum) {
                entry.decoded_cpu_bytes = 0;
                entry.gpu_bytes = 0;
            }
        }
    }
}

pub fn descriptors_from_scene(scene: &Value) -> Vec<AssetDescriptor> {
    scene
        .get("assets")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|asset| {
            let asset_id = asset.get("assetId")?.as_str()?.to_string();
            let disk_bytes = asset.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0);
            let width = asset.get("width").and_then(Value::as_u64).unwrap_or(0);
            let height = asset.get("height").and_then(Value::as_u64).unwrap_or(0);
            let decoded = width.saturating_mul(height).saturating_mul(4);
            Some(AssetDescriptor {
                asset_id,
                checksum: asset
                    .get("checksum")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                disk_bytes,
                estimated_decoded_bytes: decoded.max(disk_bytes),
                estimated_gpu_bytes: decoded,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn asset(id: &str, checksum: &str) -> AssetDescriptor {
        AssetDescriptor {
            asset_id: id.to_string(),
            checksum: checksum.to_string(),
            disk_bytes: 10,
            estimated_decoded_bytes: 100,
            estimated_gpu_bytes: 100,
        }
    }

    #[test]
    fn deduplicates_aliases_by_sha256() {
        let mut cache = AssetCacheManager::new(1024, 1024);
        cache.register(asset("logo_a", "same-hash"));
        cache.register(asset("logo_b", "same-hash"));
        let status = cache.status();
        assert_eq!(status.unique_assets, 1);
        assert_eq!(status.aliases, 2);
        assert_eq!(status.disk_bytes, 10);
    }

    #[test]
    fn protects_referenced_program_assets_under_pressure() {
        let mut cache = AssetCacheManager::new(0, 0);
        cache.register(asset("program_logo", "hash-a"));
        cache.reference("program", "program_logo", AssetPriority::Program);
        cache.promote("program_logo", 100, 100);
        let status = cache.status();
        assert_eq!(status.decoded_cpu_bytes, 100);
        assert_eq!(status.gpu_bytes, 100);
    }

    #[test]
    fn evicts_unreferenced_resident_tiers_but_keeps_disk_record() {
        let mut cache = AssetCacheManager::new(50, 50);
        cache.register(asset("old", "hash-old"));
        cache.promote("old", 100, 100);
        let status = cache.status();
        assert_eq!(status.unique_assets, 1);
        assert_eq!(status.decoded_cpu_bytes, 0);
        assert_eq!(status.gpu_bytes, 0);
        assert_eq!(status.disk_bytes, 10);
    }
}
