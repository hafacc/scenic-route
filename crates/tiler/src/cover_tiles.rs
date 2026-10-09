//! The tree cover below the zoom its strokes are drawn at: the drawn stretches as a density pyramid.

use std::collections::HashMap;
use std::fs;
use std::path::Path;

use crate::Fallible;
use crate::binfmt::Coord;
use crate::geometry::METERS_PER_DEGREE_LAT;
use crate::raster::{MIN_ZOOM, TILE_SIZE, encode_webp, lat_to_pixel_y, lng_to_pixel_x};

/// The deepest level baked; from the next one up the client strokes the stretches themselves.
pub const MAX_ZOOM: u32 = 13;
/// A stroke's width at `MAX_ZOOM`, in pixels: the 1.98 px it is drawn at one level in, halved.
/// Coarser levels halve it again, which holds it at one width on the ground at every zoom.
const STROKE_PIXELS: f64 = 0.99;
/// From here in a path is drawn as the line it is, so the gaps the strokes show at z14 are still gaps.
const SHARP_ZOOM: u32 = 12;
/// A path is walked in steps this long, in pixels, each adding its length to the pixels about it.
const STEP_PIXELS: f64 = 0.25;
/// Below `SHARP_ZOOM`: a step's share for the pixel before, its own, and the one after, along each axis.
const SPREAD: [f32; 3] = [0.25, 0.5, 0.25];
/// Below `SHARP_ZOOM`: up to here a pixel is as opaque as its strokes are wide, past it the rest is approached.
const KNEE: f64 = 0.5;
/// Below `SHARP_ZOOM`: what no amount of path reaches, so a whole borough is a texture and not a block.
const CEILING: f64 = 0.95;
/// Below this the pixel is invisible under the layer's opacity, and a tile of them is not written.
const MIN_ALPHA: u8 = 4;

pub struct Stats {
    pub tiles: usize,
    pub bytes: usize,
}

/// The part of `poly` between two fractions of its length, measured as the sampler measures it.
pub fn cut(poly: &[Coord], from: f64, to: f64, meters_per_degree_lng: f64) -> Vec<Coord> {
    let mut along = Vec::with_capacity(poly.len());
    let mut total = 0.0;
    along.push(0.0);
    for pair in poly.windows(2) {
        let east = (pair[1].lng - pair[0].lng) * meters_per_degree_lng;
        let north = (pair[1].lat - pair[0].lat) * METERS_PER_DEGREE_LAT;
        total += east.hypot(north);
        along.push(total);
    }
    let at = |distance: f64| -> Coord {
        let mut vertex = 1;
        while vertex < poly.len() - 1 && along[vertex] < distance {
            vertex += 1;
        }
        let span = along[vertex] - along[vertex - 1];
        let share = if span > 0.0 {
            (distance - along[vertex - 1]) / span
        } else {
            0.0
        };
        Coord {
            lng: poly[vertex - 1].lng + share * (poly[vertex].lng - poly[vertex - 1].lng),
            lat: poly[vertex - 1].lat + share * (poly[vertex].lat - poly[vertex - 1].lat),
        }
    };
    if poly.len() < 2 {
        return Vec::new();
    }
    let (start, end) = (from * total, to * total);
    let mut line = vec![at(start)];
    for vertex in 1..poly.len() - 1 {
        if along[vertex] > start && along[vertex] < end {
            line.push(poly[vertex]);
        }
    }
    line.push(at(end));
    line
}

/// Per tile of `zoom` the lines reach, the length of line about each of its pixels, in pixels.
/// At the sharp levels a step is shared between the four pixels round it by how near each is, which
/// is an antialiased line; below them it is spread over nine, as strokes too fine to tell apart.
pub fn lengths(lines: &[Vec<Coord>], zoom: u32) -> HashMap<(u32, u32), Vec<f32>> {
    let mut tiles: HashMap<(u32, u32), Vec<f32>> = HashMap::new();
    let size = TILE_SIZE as f64;
    let mut add = |x: f64, y: f64, length: f32| {
        let tile = ((x / size).floor() as u32, (y / size).floor() as u32);
        let pixel = y.rem_euclid(size) as usize * TILE_SIZE + x.rem_euclid(size) as usize;
        tiles
            .entry(tile)
            .or_insert_with(|| vec![0.0; TILE_SIZE * TILE_SIZE])[pixel] += length;
    };
    for line in lines {
        for pair in line.windows(2) {
            let (from_x, from_y) = (
                lng_to_pixel_x(pair[0].lng, zoom),
                lat_to_pixel_y(pair[0].lat, zoom),
            );
            let (to_x, to_y) = (
                lng_to_pixel_x(pair[1].lng, zoom),
                lat_to_pixel_y(pair[1].lat, zoom),
            );
            let length = (to_x - from_x).hypot(to_y - from_y);
            let steps = (length / STEP_PIXELS).ceil().max(1.0) as usize;
            let each = (length / steps as f64) as f32;
            for step in 0..steps {
                let share = (step as f64 + 0.5) / steps as f64;
                let x = from_x + share * (to_x - from_x);
                let y = from_y + share * (to_y - from_y);
                if zoom >= SHARP_ZOOM {
                    // Measured from pixel centers, so a line down a pixel's middle is that pixel's alone.
                    let (left, top) = ((x - 0.5).floor(), (y - 0.5).floor());
                    let (right, down) = ((x - 0.5 - left) as f32, (y - 0.5 - top) as f32);
                    add(left, top, each * (1.0 - right) * (1.0 - down));
                    add(left + 1.0, top, each * right * (1.0 - down));
                    add(left, top + 1.0, each * (1.0 - right) * down);
                    add(left + 1.0, top + 1.0, each * right * down);
                } else {
                    for (down, tall) in SPREAD.iter().enumerate() {
                        for (across, wide) in SPREAD.iter().enumerate() {
                            add(
                                x.floor() + across as f64 - 1.0,
                                y.floor() + down as f64 - 1.0,
                                each * tall * wide,
                            );
                        }
                    }
                }
            }
        }
    }
    tiles
}

/// How opaque a pixel is with `length` pixels of stroke about it: their own share of it, as an
/// antialiased line's is. Below the sharp levels that is eased toward a ceiling, where it would be
/// strokes overlapping; at them it is the line itself, and full where two share a pixel.
pub fn alpha(length: f32, zoom: u32) -> u8 {
    let width = STROKE_PIXELS / f64::from(1u32 << (MAX_ZOOM - zoom));
    let share = f64::from(length) * width;
    let covered = if zoom >= SHARP_ZOOM {
        share.min(1.0)
    } else if share <= KNEE {
        share
    } else {
        let room = CEILING - KNEE;
        KNEE + room * (1.0 - (-(share - KNEE) / room).exp())
    };
    (covered * 255.0).round() as u8
}

/// The drawn stretches of a runs file as lines, each cut from its edge's polyline.
pub fn lines(
    runs: &[u8],
    polyline: impl Fn(u32) -> Vec<Coord>,
    meters_per_degree_lng: f64,
) -> Fallible<Vec<Vec<Coord>>> {
    let stretches = crate::canopy_runs::stretches(runs)
        .ok_or("the canopy runs to rasterize are not a whole file")?;
    let mut lines = Vec::new();
    for (edge, drawn) in stretches {
        let poly = polyline(edge);
        for (from, to) in drawn {
            lines.push(cut(&poly, from, to, meters_per_degree_lng));
        }
    }
    Ok(lines)
}

/// Writes `<dir>/{z}/{x}/{y}.webp` for every tile with cover in it, cover in alpha and no color.
/// The directory is made even when no tile is, since its presence is what says the pass ran.
pub fn render(lines: &[Vec<Coord>], dir: &Path) -> Fallible<Stats> {
    match fs::remove_dir_all(dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    fs::create_dir_all(dir)?;
    let mut stats = Stats { tiles: 0, bytes: 0 };
    for zoom in MIN_ZOOM..=MAX_ZOOM {
        let mut tiles: Vec<((u32, u32), Vec<f32>)> = lengths(lines, zoom).into_iter().collect();
        tiles.sort_by_key(|(tile, _)| *tile);
        for ((x, y), field) in tiles {
            let mut pixels = vec![0u8; TILE_SIZE * TILE_SIZE * 4];
            let mut painted = false;
            for (pixel, length) in field.iter().enumerate() {
                let value = alpha(*length, zoom);
                if value >= MIN_ALPHA {
                    pixels[pixel * 4 + 3] = value;
                    painted = true;
                }
            }
            if !painted {
                continue;
            }
            let encoded = encode_webp(&pixels)?;
            let column = dir.join(zoom.to_string()).join(x.to_string());
            fs::create_dir_all(&column)?;
            fs::write(column.join(format!("{y}.webp")), &encoded)?;
            stats.tiles += 1;
            stats.bytes += encoded.len();
        }
    }
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::raster::{pixel_x_to_lng, pixel_y_to_lat};

    /// A point `x`, `y` pixels into tile (2412, 3078) of z13, which is in Brooklyn.
    fn at(x: f64, y: f64, zoom: u32) -> Coord {
        let scale = f64::from(1u32 << (MAX_ZOOM - zoom));
        Coord {
            lng: pixel_x_to_lng((2412.0 * 256.0 + x) / scale, zoom),
            lat: pixel_y_to_lat((3078.0 * 256.0 + y) / scale, zoom),
        }
    }

    /// A point `x`, `y` pixels of `zoom` into the tile of that level over the same corner of Brooklyn.
    fn px(x: f64, y: f64, zoom: u32) -> Coord {
        let (tile_x, tile_y) = (2412u32 >> (MAX_ZOOM - zoom), 3078u32 >> (MAX_ZOOM - zoom));
        Coord {
            lng: pixel_x_to_lng(f64::from(tile_x) * 256.0 + x, zoom),
            lat: pixel_y_to_lat(f64::from(tile_y) * 256.0 + y, zoom),
        }
    }

    fn total(tiles: &HashMap<(u32, u32), Vec<f32>>) -> f32 {
        tiles.values().flatten().sum()
    }

    #[test]
    fn at_the_sharp_levels_a_line_down_a_row_of_pixels_is_in_that_row_alone() {
        let line = vec![at(10.0, 20.5, 13), at(30.0, 20.5, 13)];
        let tiles = lengths(&[line], 13);

        assert_eq!(tiles.len(), 1);
        let field = &tiles[&(2412, 3078)];
        assert!((total(&tiles) - 20.0).abs() < 0.01, "20 px of line");
        assert!((field[20 * 256 + 15] - 1.0).abs() < 0.01, "a pixel's width");
        assert_eq!(field[21 * 256 + 15], 0.0);
        assert_eq!(field[19 * 256 + 15], 0.0);
        assert_eq!(
            alpha(field[20 * 256 + 15], 13),
            252,
            "one stroke, 0.99 px wide"
        );
    }

    /// A line on the boundary of two rows is half in each: antialiased, not doubled.
    #[test]
    fn a_line_between_two_rows_is_shared_by_them() {
        let line = vec![at(10.0, 21.0, 13), at(30.0, 21.0, 13)];
        let tiles = lengths(&[line], 13);
        let field = &tiles[&(2412, 3078)];

        assert!((field[20 * 256 + 15] - 0.5).abs() < 0.01);
        assert!((field[21 * 256 + 15] - 0.5).abs() < 0.01);
        assert!((total(&tiles) - 20.0).abs() < 0.01);
    }

    #[test]
    fn a_gap_between_two_stretches_is_still_a_gap_at_the_sharp_levels() {
        let dashes = vec![
            vec![at(10.0, 20.5, 13), at(20.0, 20.5, 13)],
            vec![at(24.0, 20.5, 13), at(34.0, 20.5, 13)],
        ];
        let tiles = lengths(&dashes, 13);
        let field = &tiles[&(2412, 3078)];

        assert!(alpha(field[20 * 256 + 15], 13) > 240);
        assert_eq!(alpha(field[20 * 256 + 21], 13), 0, "76 m of open sidewalk");
        assert_eq!(alpha(field[20 * 256 + 22], 13), 0);
        assert!(alpha(field[20 * 256 + 28], 13) > 240);
    }

    /// Nothing is lost or made at a tile's edge or corner, whichever way the line runs.
    #[test]
    fn a_line_keeps_its_length_across_tile_edges_and_corners_at_every_level() {
        for zoom in [10, 11, 12, 13] {
            let home = 2412u32 >> (MAX_ZOOM - zoom);
            let across = vec![px(250.0, 5.5, zoom), px(262.0, 5.5, zoom)];
            let tiles = lengths(&[across], zoom);
            assert_eq!(tiles.len(), 2, "z{zoom}");
            assert!((total(&tiles) - 12.0).abs() < 0.01, "z{zoom}");
            let west: f32 = tiles
                .iter()
                .filter(|(tile, _)| tile.0 == home)
                .map(|(_, field)| field.iter().sum::<f32>())
                .sum();
            assert!((west - 6.0).abs() < 0.6, "z{zoom}: {west} of 12 px west");

            // Through the corner four tiles share, on the diagonal.
            let diagonal = vec![px(246.0, 246.0, zoom), px(266.0, 266.0, zoom)];
            let tiles = lengths(&[diagonal], zoom);
            assert_eq!(tiles.len(), 4, "z{zoom}");
            let length = 20.0 * std::f32::consts::SQRT_2;
            assert!((total(&tiles) - length).abs() < 0.01, "z{zoom}");
        }
    }

    #[test]
    fn below_the_sharp_levels_a_step_is_spread_over_the_pixels_round_it() {
        let line = vec![px(10.0, 20.5, 11), px(30.0, 20.5, 11)];
        let tiles = lengths(&[line], 11);
        let field = tiles.values().next().expect("one tile");

        assert!((total(&tiles) - 20.0).abs() < 0.01);
        assert!(
            (field[20 * 256 + 15] - 0.5).abs() < 0.01,
            "half stays in its row"
        );
        assert!(
            (field[21 * 256 + 15] - 0.25).abs() < 0.01,
            "a quarter either side"
        );
        assert_eq!(field[22 * 256 + 15], 0.0);
    }

    /// The width is held on the ground, so the same streets carry the same ink at every level.
    #[test]
    fn the_same_cover_is_as_dense_at_a_coarser_zoom() {
        // Covered paths every 4 px at z13: every 2 px at z12, one a pixel at z11.
        let rows: Vec<Vec<Coord>> = (0..16)
            .map(|row| {
                let y = 64.5 + 4.0 * f64::from(row);
                vec![at(64.0, y, 13), at(128.0, y, 13)]
            })
            .collect();
        let mean = |zoom: u32| -> f64 {
            let block = f64::from(64u32 >> (MAX_ZOOM - zoom));
            let lit: f64 = lengths(&rows, zoom)
                .values()
                .flatten()
                .map(|length| f64::from(alpha(*length, zoom)))
                .sum();
            lit / (block * block) / 255.0
        };

        let (z13, z12, z11) = (mean(13), mean(12), mean(11));
        assert!(
            (z13 - 0.2475).abs() < 0.01,
            "a 0.99 px line every 4 px: {z13}"
        );
        assert!((z12 - z13).abs() < 0.01, "{z12} at z12");
        assert!((z11 - z13).abs() < 0.02, "{z11} at z11");
    }

    #[test]
    fn more_path_is_more_opaque_and_only_the_sharp_levels_ever_fill_a_pixel() {
        assert_eq!(alpha(0.0, 13), 0);
        assert!(alpha(1.0, 13) > alpha(0.5, 13));
        // A stroke's own pixels are its width's share of them: 0.99 at z13, half that a level out.
        assert_eq!(alpha(1.0, 13), 252);
        assert_eq!(alpha(1.0, 12), 126);
        assert_eq!(alpha(0.5, 13), alpha(1.0, 12));
        assert_eq!(
            alpha(3.0, 13),
            255,
            "two sidewalks and a crossing in one pixel"
        );
        // Coarser, the same law until half, and then a ceiling no amount of path reaches.
        assert_eq!(alpha(1.0, 11), (0.2475f64 * 255.0).round() as u8);
        assert!(alpha(400.0, 9) <= 242);
    }

    #[test]
    fn the_runs_are_rasterized_from_their_own_file_and_a_damaged_one_is_refused() {
        use crate::canopy_runs::{EdgeEnds, encode};
        use crate::sampling::Runs;
        let edges = [EdgeEnds::default()];
        let runs = [Runs {
            samples: 100,
            meters: 100.0,
            runs: vec![(25, 50)],
        }];
        let (file, _) = encode(&edges, &runs, 7);
        let poly = |_: u32| vec![at(0.0, 0.5, 13), at(100.0, 0.5, 13)];

        let drawn = lines(&file, poly, 85_000.0).expect("the lines");
        assert_eq!(drawn.len(), 1);
        assert!((lng_to_pixel_x(drawn[0][0].lng, 13) - (2412.0 * 256.0 + 25.0)).abs() < 1e-6);
        assert!(lines(&file[..file.len() - 1], poly, 85_000.0).is_err());
    }

    #[test]
    fn a_stretch_is_cut_at_its_fractions_and_keeps_the_corner_between_them() {
        let poly = vec![at(0.0, 0.0, 13), at(10.0, 0.0, 13), at(10.0, 10.0, 13)];
        let scale = METERS_PER_DEGREE_LAT * poly[0].lat.to_radians().cos();
        let part = cut(&poly, 0.25, 0.75, scale);

        assert_eq!(part.len(), 3);
        assert_eq!(part[1].lng, poly[1].lng);
        assert!((part[0].lng - (poly[0].lng + poly[1].lng) / 2.0).abs() < 1e-7);
        assert!((part[2].lat - (poly[1].lat + poly[2].lat) / 2.0).abs() < 1e-7);
        assert_eq!(cut(&poly, 0.0, 1.0, scale).len(), 3);
        assert!(cut(&poly[..1], 0.0, 1.0, scale).is_empty());
    }

    #[test]
    fn the_pyramid_is_one_webp_a_tile_at_every_baked_zoom_and_nothing_where_there_is_no_cover() {
        let dir = std::env::temp_dir().join(format!("tiler-cover-tiles-{}", std::process::id()));
        fs::create_dir_all(dir.join("13/1")).expect("a stale tile's column");
        fs::write(dir.join("13/1/1.webp"), b"stale").expect("a stale tile");
        let line = vec![at(10.0, 20.5, 13), at(200.0, 20.5, 13)];

        let stats = render(&[line], &dir).expect("a render");

        assert_eq!(stats.tiles, (MAX_ZOOM - MIN_ZOOM + 1) as usize);
        let empty = dir.join("empty");
        assert_eq!(render(&[], &empty).expect("a render").tiles, 0);
        assert!(
            empty.is_dir(),
            "no cover is still a pyramid, with nothing in it"
        );
        assert!(
            !dir.join("13/1/1.webp").exists(),
            "the last render's tiles go"
        );
        let tile = fs::read(dir.join("13/2412/3078.webp")).expect("the tile");
        assert_eq!(&tile[0..4], b"RIFF");
        assert!(dir.join("9/150/192.webp").is_file());
        assert_eq!(stats.bytes, {
            let mut bytes = 0;
            for zoom in MIN_ZOOM..=MAX_ZOOM {
                for column in fs::read_dir(dir.join(zoom.to_string())).expect("a level") {
                    for tile in fs::read_dir(column.expect("a column").path()).expect("tiles") {
                        bytes += tile.expect("a tile").metadata().expect("a size").len() as usize;
                    }
                }
            }
            bytes
        });
        fs::remove_dir_all(&dir).ok();
    }
}
