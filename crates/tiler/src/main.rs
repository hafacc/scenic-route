//! The tree-cover model's numeric half: cover field and distribution, tile pyramids, street chunks.

// graph.rs's stats `json!` literal has more keys than the default 128 expansion steps allow.
#![recursion_limit = "512"]

mod association;
mod binfmt;
mod bridge;
mod build;
mod canopy;
mod caster_chunks;
mod chunks;
mod commercial;
mod conflate;
mod corners;
mod crown;
mod dem;
mod densities;
mod direct_canopy;
mod elevation;
mod genus_field;
mod geometry;
mod graph;
mod graph_cache;
mod heights;
mod historic;
mod industrial;
mod ingest;
mod invariants;
mod manifest;
mod ndsm;
mod raster;
mod relief;
mod sampling;
mod scenic;
mod shade;
mod sidewalks;

use std::error::Error;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use serde::Serialize;

pub type Fallible<T> = Result<T, Box<dyn Error + Send + Sync>>;

/// Returns freed pages to the OS, since glibc keeps a finished pass's small frees for its own reuse.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
pub fn trim_heap() {
    unsafe extern "C" {
        fn malloc_trim(pad: usize) -> i32;
    }
    // SAFETY: malloc_trim only releases free pages; no live allocation moves.
    unsafe {
        malloc_trim(0);
    }
}

#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
pub fn trim_heap() {}

/// `--memory`: a byte budget for the passes' optional caches, or `auto` to size it from the machine.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Memory {
    Auto,
    Bytes(u64),
}

const GIB: u64 = 1 << 30;

// What auto leaves the rest of the build: the casters, graph and grids that aren't optional.
const AUTO_RESERVE: u64 = 3 * GIB;

/// `auto`, or a size such as `0`, `512M`, `12G` or `1.5GiB`; suffixes are powers of 1024.
fn memory(value: &str) -> Result<Memory, String> {
    let value = value.trim();
    if value.eq_ignore_ascii_case("auto") {
        return Ok(Memory::Auto);
    }
    let invalid = || format!("expected a size like 512M or 12G, or \"auto\", got {value:?}");
    let split = value
        .find(|character: char| !(character.is_ascii_digit() || character == '.'))
        .unwrap_or(value.len());
    let (number, suffix) = value.split_at(split);
    let number: f64 = number.parse().map_err(|_| invalid())?;
    let shift = match suffix.to_ascii_uppercase().as_str() {
        "" | "B" => 0,
        "K" | "KB" | "KIB" => 10,
        "M" | "MB" | "MIB" => 20,
        "G" | "GB" | "GIB" => 30,
        "T" | "TB" | "TIB" => 40,
        _ => return Err(invalid()),
    };
    let bytes = number * (1u64 << shift) as f64;
    if !bytes.is_finite() || bytes >= u64::MAX as f64 {
        return Err(invalid());
    }
    Ok(Memory::Bytes(bytes.round() as u64))
}

/// A size in GiB for the log.
pub fn gib(bytes: u64) -> String {
    format!("{:.1} GiB", bytes as f64 / GIB as f64)
}

/// A `/proc` style `Key:  1234 kB` line's value in bytes.
fn proc_kib(text: &str, key: &str) -> Option<u64> {
    text.lines().find_map(|line| {
        let rest = line.strip_prefix(key)?.strip_prefix(':')?;
        let kib: u64 = rest.trim().strip_suffix("kB")?.trim().parse().ok()?;
        Some(kib * 1024)
    })
}

/// The bytes this process's cgroup v2 still allows, None when unlimited or not on cgroup v2.
#[cfg(target_os = "linux")]
fn cgroup_room() -> Option<u64> {
    let membership = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    let path = membership
        .lines()
        .find_map(|line| line.strip_prefix("0::"))?;
    let directory = Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/'));
    let read = |name: &str| std::fs::read_to_string(directory.join(name)).ok();
    let limit = read("memory.max")?;
    let limit: u64 = limit.trim().parse().ok()?; // "max" doesn't parse: unlimited
    let current: u64 = read("memory.current")?.trim().parse().ok()?;
    Some(limit.saturating_sub(current))
}

/// What `auto` leaves the caches: 3/4 of what's free past a fixed reserve, but never under an
/// eighth of it, so a small machine still holds a little rather than regenerating everything.
fn auto_budget(available: u64) -> u64 {
    (available.saturating_sub(AUTO_RESERVE) / 4 * 3).max(available / 8)
}

/// The build's cache budget in bytes, and how it was arrived at for the log.
pub fn memory_budget(memory: Memory) -> (u64, String) {
    match memory {
        Memory::Bytes(bytes) => (bytes, "--memory".to_owned()),
        Memory::Auto => detect_budget(),
    }
}

#[cfg(target_os = "linux")]
fn detect_budget() -> (u64, String) {
    let meminfo = std::fs::read_to_string("/proc/meminfo").ok();
    let Some(free) = meminfo.and_then(|text| proc_kib(&text, "MemAvailable")) else {
        return (0, "auto: no MemAvailable, so none".to_owned());
    };
    match cgroup_room() {
        Some(room) if room < free => (
            auto_budget(room),
            format!(
                "auto: cgroup room {}, MemAvailable {}",
                gib(room),
                gib(free)
            ),
        ),
        _ => (
            auto_budget(free),
            format!("auto: MemAvailable {}", gib(free)),
        ),
    }
}

#[cfg(not(target_os = "linux"))]
fn detect_budget() -> (u64, String) {
    (0, "auto: not detected on this platform, so none".to_owned())
}

/// The process's peak resident set so far (VmHWM), where the platform reports one.
pub fn peak_rss() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    proc_kib(&status, "VmHWM")
}

/// A pass's report as a file, since the next package.json command reads it without a pipe.
pub fn write_report<T: Serialize>(path: &Path, report: &T) -> Fallible<()> {
    if let Some(directory) = path.parent() {
        std::fs::create_dir_all(directory)?;
    }
    Ok(std::fs::write(path, serde_json::to_string(report)?)?)
}

/// `--jobs`: rayon threads, a count or `half`; rayon's one-per-core default starves the machine.
fn jobs(value: &str) -> Result<usize, String> {
    if value == "half" {
        let cores = std::thread::available_parallelism()
            .map_err(|error| format!("the machine's cores: {error}"))?
            .get();
        Ok((cores / 2).max(1))
    } else {
        match value.parse::<usize>() {
            Ok(0) | Err(_) => Err(format!(
                "expected a positive integer or \"half\", got {value:?}"
            )),
            Ok(threads) => Ok(threads),
        }
    }
}

#[derive(Parser)]
#[command(
    name = "tiler",
    about = "the scenic-route model: tiles, chunks and the routing graph"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Render a whole tile build from a plan file: every pass, in one process.
    Build {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long, value_parser = jobs)]
        jobs: Option<usize>,
        /// Memory the caches may use, e.g. `512M`, `12G` or `0` for none; `auto` sizes it from
        /// what's free, and is the default. It never changes the output.
        #[arg(long, value_parser = memory, default_value = "auto")]
        memory: Memory,
        /// Passes to run, each optionally narrowed to a city: `graph,shade` or `graph:nyc`.
        #[arg(long, value_delimiter = ',')]
        only: Vec<String>,
        /// Rerun the selected passes even if their stamps hold; with no `--only`, a full rebuild.
        #[arg(long)]
        force: bool,
    },
    /// Fill the canopy crown heights and the density blobs in place; report cover stats.
    Ingest {
        #[arg(long)]
        params: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Bin a LiDAR point cloud into a height-above-ground raster and measure each footprint's roof.
    Ndsm {
        #[arg(long)]
        params: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Stamp the inputs the graph's durable key space depends on, for the shed guard.
    GraphInputs {
        #[arg(long)]
        plan: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
    /// Run the graph pipeline over the committed fixture and report the durable key hash.
    KeyProbe {
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/streets.bin")]
        streets: PathBuf,
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/paths.bin")]
        paths: PathBuf,
        #[arg(long, default_value = "crates/tiler/fixtures/key-probe/sidewalks.bin")]
        sidewalks: PathBuf,
        /// The graph the probe has to write somewhere and nothing reads.
        #[arg(long, default_value_os_t = std::env::temp_dir().join("scenic-route-key-probe.bin"))]
        out: PathBuf,
        #[arg(long)]
        report: PathBuf,
    },
}

fn run() -> Fallible<()> {
    match Cli::parse().command {
        Command::Build {
            plan,
            jobs,
            memory,
            only,
            force,
        } => build::run(
            &plan,
            jobs,
            memory_budget(memory),
            &build::Selection::new(&only, force)?,
        ),
        Command::Ingest { params, report } => ingest::run(&params, &report),
        Command::Ndsm { params, report } => ndsm::run(&params, &report),
        Command::GraphInputs { plan, report } => build::graph_inputs(&plan, &report),
        // Only key-bearing sources are passed, so the hash stamps key assignment behavior.
        // Every field is spelled out so a new graph input won't compile until it is classified.
        Command::KeyProbe {
            streets,
            paths,
            sidewalks,
            out,
            report,
        } => graph::run(
            &graph::Args {
                streets,
                paths: Some(paths),
                sidewalks: Some(sidewalks),
                ferries: None,
                transit: None,
                landmarks: None,
                art: None,
                highways: None,
                commercial: None,
                industrial: None,
                historic: None,
                land: None,
                out,
                stranded_out: None,
                buildings: None,
                shade_params: None,
                shade_dir: None,
                elevation_bounds: None,
                alleys: true,
                existence_ceilings: graph::SURVEYED_CEILINGS,
                canopy: None,
                cache: None,
                probe: true,
                report: Some(report),
                memory_budget: 0,
            },
            None,
        )
        .map(drop),
    }
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("tiler: {error}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{GIB, Memory, auto_budget, jobs, memory, proc_kib};

    #[test]
    fn a_count_is_taken_verbatim() {
        assert_eq!(jobs("3").expect("a count"), 3);
    }

    #[test]
    fn half_the_cores_is_never_none_of_them() {
        let cores = std::thread::available_parallelism()
            .expect("the machine's cores")
            .get();
        let threads = jobs("half").expect("half");

        assert_eq!(threads, (cores / 2).max(1));
        assert!(threads >= 1);
    }

    #[test]
    fn zero_and_nonsense_are_rejected() {
        for value in ["0", "-1", "1.5", "all", ""] {
            assert!(jobs(value).is_err(), "--jobs {value}");
        }
    }

    #[test]
    fn a_memory_size_reads_with_or_without_a_binary_suffix() {
        assert_eq!(memory("0"), Ok(Memory::Bytes(0)));
        assert_eq!(memory("4096"), Ok(Memory::Bytes(4096)));
        assert_eq!(memory("512M"), Ok(Memory::Bytes(512 << 20)));
        assert_eq!(memory("512m"), Ok(Memory::Bytes(512 << 20)));
        assert_eq!(memory("12G"), Ok(Memory::Bytes(12 * GIB)));
        assert_eq!(memory("12GiB"), Ok(Memory::Bytes(12 * GIB)));
        assert_eq!(memory("1.5G"), Ok(Memory::Bytes(3 * GIB / 2)));
        assert_eq!(memory("64K"), Ok(Memory::Bytes(64 << 10)));
        assert_eq!(memory("2T"), Ok(Memory::Bytes(2 << 40)));
        assert_eq!(memory("auto"), Ok(Memory::Auto));
        assert_eq!(memory(" AUTO "), Ok(Memory::Auto));
    }

    #[test]
    fn a_nonsense_memory_size_is_rejected() {
        for value in ["", "G", "-1G", "12X", "1.2.3G", "twelve", "12 G", "1e3G"] {
            assert!(memory(value).is_err(), "--memory {value}");
        }
    }

    #[test]
    fn auto_keeps_three_gib_back_and_takes_three_quarters_of_the_rest() {
        assert_eq!(auto_budget(0), 0);
        assert_eq!(auto_budget(7 * GIB), 3 * GIB);
        assert_eq!(auto_budget(15 * GIB), 9 * GIB);
    }

    #[test]
    fn auto_takes_an_eighth_of_a_small_machine() {
        assert_eq!(auto_budget(3 * GIB), 3 * GIB / 8);
        assert_eq!(auto_budget(2 * GIB), GIB / 4);
        assert_eq!(auto_budget(4 * GIB), 3 * GIB / 4);
        assert_eq!(auto_budget(5 * GIB), 3 * GIB / 2);
    }

    #[test]
    fn proc_sizes_read_in_kib() {
        let meminfo =
            "MemTotal:       16384000 kB\nMemFree:  100 kB\nMemAvailable:   15000000 kB\n";
        assert_eq!(proc_kib(meminfo, "MemAvailable"), Some(15_000_000 * 1024));
        assert_eq!(proc_kib(meminfo, "MemFree"), Some(100 * 1024));
        assert_eq!(proc_kib(meminfo, "VmHWM"), None);
        assert_eq!(proc_kib("VmHWM:\t  2048 kB\n", "VmHWM"), Some(2048 * 1024));
    }
}
