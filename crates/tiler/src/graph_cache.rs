//! The graph pass's disk cache: one city's topology and one file per attribute column over it.
//! Every column's key folds the base's, which is what makes merging a column by position safe.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::Fallible;

/// The finished edge list: nodes, edges, geometry, names and the durable keys.
pub const BASE: &str = "base";
pub const LANDMARKS: &str = "landmarks";
pub const ART: &str = "art";
pub const HIGHWAYS: &str = "highways";
pub const COMMERCIAL: &str = "commercial";
/// The ascent and descent rows, cached as one entry: they come out of one pass over the DEM field.
pub const RELIEF: &str = "relief";
pub const CANOPY: &str = "canopy";
pub const INDUSTRIAL: &str = "industrial";
pub const HISTORIC: &str = "historic";
pub const BRIDGE: &str = "bridge";
/// One entry per sun bin, keyed on that bin alone.
pub const SHADE: &str = "shade";

/// This build's entry names: the base's content key and one per column, each folding `base`.
#[derive(Clone)]
pub struct Keys {
    pub dir: PathBuf,
    pub base: String,
    pub landmarks: String,
    pub art: String,
    pub highways: String,
    pub commercial: String,
    pub relief: String,
    pub canopy: String,
    pub industrial: String,
    pub historic: String,
    pub bridge: String,
    /// In schedule order; empty for a city that bakes no per-edge shade.
    pub shade: Vec<String>,
}

/// Whether an entry is on disk, without opening it; a cached relief column skips reading the DEM.
pub fn holds(dir: &Path, name: &str, key: &str) -> bool {
    entry(dir, name, key).is_file()
}

fn entry(dir: &Path, name: &str, key: &str) -> PathBuf {
    dir.join(format!("{name}-{key}.bin"))
}

/// One city's entries, and what this build asked for.
pub struct Cache {
    dir: PathBuf,
    /// Every entry read or written this build, so `prune` can remove the rest.
    claimed: HashSet<String>,
}

impl Cache {
    pub fn new(dir: &Path) -> Cache {
        Cache {
            dir: dir.to_path_buf(),
            claimed: HashSet::new(),
        }
    }

    /// The bytes this key names if exactly `expect` of them; a short file is a killed build's.
    pub fn load(&mut self, name: &str, key: &str, expect: usize) -> Fallible<Option<Vec<u8>>> {
        self.claimed.insert(file_name(name, key));
        let path = entry(&self.dir, name, key);
        match fs::read(&path) {
            Ok(bytes) if bytes.len() == expect => Ok(Some(bytes)),
            Ok(_) => {
                fs::remove_file(&path)?;
                Ok(None)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(format!("{}: {error}", path.display()).into()),
        }
    }

    /// The same, for the base, whose length nothing knows in advance.
    pub fn load_base(&mut self, key: &str) -> Fallible<Option<Vec<u8>>> {
        self.claimed.insert(file_name(BASE, key));
        match fs::read(entry(&self.dir, BASE, key)) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    /// Written through a temporary name and renamed, so a killed build leaves no partial entry.
    pub fn store(&mut self, name: &str, key: &str, bytes: &[u8]) -> Fallible<()> {
        self.claimed.insert(file_name(name, key));
        fs::create_dir_all(&self.dir)?;
        let staged = self.dir.join(format!(".writing-{name}"));
        fs::write(&staged, bytes)?;
        Ok(fs::rename(&staged, entry(&self.dir, name, key))?)
    }

    /// Remove every entry this build did not ask for; one generation is all the cache keeps.
    pub fn prune(&self) -> Fallible<()> {
        let entries = match fs::read_dir(&self.dir) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        };
        for entry in entries {
            let path = entry?.path();
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            if !self.claimed.contains(&name) {
                fs::remove_file(&path)?;
            }
        }
        Ok(())
    }
}

fn file_name(name: &str, key: &str) -> String {
    format!("{name}-{key}.bin")
}

/// A little-endian writer for the base entry; its key folds the tiler's code, so no version.
#[derive(Default)]
pub struct Writer {
    pub bytes: Vec<u8>,
}

impl Writer {
    pub fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    pub fn u16(&mut self, value: u16) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u32(&mut self, value: u32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn u64(&mut self, value: u64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn usize(&mut self, value: usize) {
        self.u32(value as u32);
    }

    pub fn i32(&mut self, value: i32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f32(&mut self, value: f32) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn f64(&mut self, value: f64) {
        self.bytes.extend_from_slice(&value.to_le_bytes());
    }

    pub fn bytes(&mut self, value: &[u8]) {
        self.usize(value.len());
        self.bytes.extend_from_slice(value);
    }
}

/// The reader for what `Writer` wrote; every read is bounds-checked against a truncated file.
pub struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Reader<'a> {
        Reader { bytes, at: 0 }
    }

    fn take(&mut self, count: usize) -> Fallible<&'a [u8]> {
        let end = self
            .at
            .checked_add(count)
            .filter(|end| *end <= self.bytes.len())
            .ok_or("a cached graph base ends in the middle of a field")?;
        let slice = &self.bytes[self.at..end];
        self.at = end;
        Ok(slice)
    }

    pub fn u8(&mut self) -> Fallible<u8> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> Fallible<u16> {
        Ok(u16::from_le_bytes(self.take(2)?.try_into()?))
    }

    pub fn u32(&mut self) -> Fallible<u32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn u64(&mut self) -> Fallible<u64> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into()?))
    }

    pub fn usize(&mut self) -> Fallible<usize> {
        Ok(self.u32()? as usize)
    }

    pub fn i32(&mut self) -> Fallible<i32> {
        Ok(i32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn f32(&mut self) -> Fallible<f32> {
        Ok(f32::from_le_bytes(self.take(4)?.try_into()?))
    }

    pub fn f64(&mut self) -> Fallible<f64> {
        Ok(f64::from_le_bytes(self.take(8)?.try_into()?))
    }

    pub fn bytes(&mut self) -> Fallible<&'a [u8]> {
        let count = self.usize()?;
        self.take(count)
    }

    /// That every field was read, so the two sides of the format agree.
    pub fn finish(&self) -> Fallible<()> {
        if self.at == self.bytes.len() {
            Ok(())
        } else {
            Err("a cached graph base carries bytes nothing read".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tiler-graph-cache-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        fs::remove_dir_all(&dir).ok();
        dir
    }

    #[test]
    fn an_entry_comes_back_under_its_own_key_and_no_other() {
        let dir = scratch("keys");
        let mut cache = Cache::new(&dir);
        cache.store(LANDMARKS, "abc", b"column").expect("a store");

        assert_eq!(
            cache.load(LANDMARKS, "abc", 6).expect("a load").as_deref(),
            Some(&b"column"[..])
        );
        assert!(
            cache.load(LANDMARKS, "def", 6).expect("a load").is_none(),
            "a key nothing wrote is a miss, not another key's bytes"
        );
        assert!(cache.load(ART, "abc", 6).expect("a load").is_none());
    }

    /// A killed build leaves a column shorter than the edge list, which must not be assembled.
    #[test]
    fn an_entry_of_the_wrong_length_is_a_miss() {
        let dir = scratch("truncated");
        let mut cache = Cache::new(&dir);
        cache.store(INDUSTRIAL, "abc", b"short").expect("a store");

        assert!(cache.load(INDUSTRIAL, "abc", 40).expect("a load").is_none());
        assert!(!holds(&dir, INDUSTRIAL, "abc"), "and it is taken away");
    }

    #[test]
    fn what_this_build_did_not_ask_for_is_pruned() {
        let dir = scratch("prune");
        let mut cache = Cache::new(&dir);
        cache.store(BASE, "old", b"a base").expect("a store");
        cache.store(CANOPY, "old", b"a column").expect("a store");

        let mut next = Cache::new(&dir);
        next.store(BASE, "new", b"a base").expect("a store");
        next.load(CANOPY, "new", 8).expect("a load");
        next.prune().expect("a pruning");

        assert!(holds(&dir, BASE, "new"));
        assert!(!holds(&dir, BASE, "old"));
        assert!(!holds(&dir, CANOPY, "old"), "a column of a base nobody has");
    }

    #[test]
    fn the_reader_reads_back_what_the_writer_wrote() {
        let mut writer = Writer::default();
        writer.f64(-73.9);
        writer.u32(7);
        writer.i32(-3);
        writer.f32(1.5);
        writer.u64(0xdead_beef_cafe);
        writer.bytes(b"nostrand av");

        let mut reader = Reader::new(&writer.bytes);
        assert_eq!(reader.f64().expect("a float"), -73.9);
        assert_eq!(reader.u32().expect("a count"), 7);
        assert_eq!(reader.i32().expect("a coordinate"), -3);
        assert_eq!(reader.f32().expect("a length"), 1.5);
        assert_eq!(reader.u64().expect("a hash"), 0xdead_beef_cafe);
        assert_eq!(reader.bytes().expect("a name"), b"nostrand av");
        reader.finish().expect("every field read");
    }

    #[test]
    fn a_truncated_entry_is_an_error_rather_than_a_panic() {
        let mut writer = Writer::default();
        writer.u64(1);
        let mut reader = Reader::new(&writer.bytes[..5]);

        assert!(reader.u64().is_err());
    }
}
