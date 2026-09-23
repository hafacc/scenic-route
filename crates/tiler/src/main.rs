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
            only,
            force,
        } => build::run(&plan, jobs, &build::Selection::new(&only, force)?),
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
    use super::jobs;

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
}
