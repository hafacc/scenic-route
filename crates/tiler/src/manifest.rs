//! The parts of src/tree-cover/manifest.json the tiler reads, the one source of model constants.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Bounds {
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
}

#[derive(Deserialize)]
pub struct SourceFile {
    pub file: String,
}

/// The measured LiDAR canopy polygons, when a city has them; the tiler rasterizes them itself.
#[derive(Deserialize)]
pub struct CanopyLayer {
    pub file: String,
}

/// Presence marks a city the genus overlay renders.
#[derive(Deserialize)]
pub struct GenusLayer {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldLayer {
    pub trees: SourceFile,
    pub land: SourceFile,
    pub canopy: Option<CanopyLayer>,
    pub genus: Option<GenusLayer>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreetLayer {
    pub file: String,
    pub sidewalk_inset_meters: f64, // curb to the center of the sidewalk, either side
}

#[derive(Deserialize)]
pub struct City {
    pub id: String,
    pub bounds: Bounds,
    pub field: FieldLayer,
    pub streets: StreetLayer,
    /// The OSM pedestrian network, absent for a city whose ingest found none.
    pub paths: Option<PathLayer>,
}

#[derive(Deserialize)]
pub struct PathLayer {
    pub file: String,
}

#[derive(Deserialize)]
pub struct Manifest {
    pub cities: Vec<City>,
}

/// What the density pass reports back for the manifest, in the shape scripts/manifest.ts declares.
#[derive(Serialize)]
pub struct Distribution {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub median: f64,
    pub percentiles: BTreeMap<String, f64>,
}
