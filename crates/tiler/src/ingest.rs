//! `tiler ingest`: canopy crown heights, then the density blobs and the manifest's cover stats.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::{Fallible, densities, heights};

/// The canopy height model, one raster or a mosaic; JSON because hundreds of tiles overflow argv.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Chm {
    paths: Vec<PathBuf>,
    /// The height-above-ground band of a mosaic; absent for a single-band raster.
    #[serde(default)]
    band: Option<usize>,
    crs: String,
}

impl Chm {
    fn source(&self) -> Fallible<heights::Source> {
        match self.band {
            Some(band) => Ok(heights::Source::Mosaic {
                paths: self.paths.clone(),
                band,
            }),
            None => match self.paths.as_slice() {
                [path] => Ok(heights::Source::Single(path.clone())),
                paths => Err(format!(
                    "a single-raster canopy height model names {} rasters; a mosaic needs its band",
                    paths.len()
                )
                .into()),
            },
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Params {
    /// Empty when a city has no height model; several when surveys split a region.
    #[serde(default)]
    chm: Vec<Chm>,
    #[serde(flatten)]
    densities: densities::Params,
}

#[derive(Serialize)]
struct Report {
    #[serde(skip_serializing_if = "Option::is_none")]
    heights: Option<heights::Report>,
    #[serde(flatten)]
    densities: densities::Report,
}

pub fn run(params_file: &Path, report_file: &Path) -> Fallible<()> {
    let params: Params = serde_json::from_slice(&fs::read(params_file)?)?;
    let heights = if params.chm.is_empty() {
        eprintln!("no canopy height model; every polygon keeps an unknown height");
        None
    } else {
        let rasters = params
            .chm
            .iter()
            .map(|chm| {
                Ok(heights::Raster {
                    source: chm.source()?,
                    projection: heights::projection(&chm.crs)?,
                })
            })
            .collect::<Fallible<Vec<heights::Raster>>>()?;
        Some(heights::run(&heights::Args {
            canopy: params.densities.canopy().to_path_buf(),
            rasters,
        })?)
    };
    let densities = densities::run(&params.densities)?;
    crate::write_report(report_file, &Report { heights, densities })
}
