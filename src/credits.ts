// Where every layer on the map comes from. A plain module rather than part of the about dialog,
// because two surfaces render it now: the dialog, which shows the active region's, and the static
// about page, which shows both and is the only copy a crawler ever sees.

// One row in the data-provenance list: what a layer is, and where it comes from. `license` is the
// text of a license this app has to hand over rather than merely name, shipped under public/licenses
// and linked from the row so it is reachable rather than merely present.
export interface DataSource {
  label: string;
  detail: string;
  license?: string;
}

// The credits are per region, because the sources are: no two cities publish their canopy, their
// landmarks or their industrial land the same way, and a single list would credit New York for a map
// of the Bay Area. The dialog shows only the active region's, which is also what keeps a license
// that names one city's terms — SFMTA's below — attached to the map it actually governs; the about
// page, which has no active region, shows both under their own headings for the same reason.
export const CITY_SOURCES: Record<string, readonly DataSource[]> = {
  nyc: [
    {
      label: "Tree canopy",
      detail: "2017 LiDAR tree canopy · NYC OTI / NYC Parks",
    },
    // CC BY 4.0 makes crediting this a condition of the license, not a courtesy, and this list is
    // the app's only credits surface — the map draws no attribution control of its own.
    {
      label: "Tree heights",
      detail:
        "Ma et al. 2023, Individual structure mapping over six million trees for New York City (CC BY 4.0)",
    },
    {
      label: "Street trees",
      detail: "NYC Parks Forestry (ForMS) · NYC Open Data",
    },
    {
      label: "Streets",
      detail: "NYC Street Centerline (CSCL) · NYC Open Data",
    },
    {
      label: "Ferries",
      detail: "Staten Island Ferry (NYC DOT) & NYC Ferry GTFS",
    },
    { label: "Transit lines", detail: "MTA subway GTFS" },
    {
      label: "Landmarks",
      detail: "LPC Individual Landmark Sites · NYC Open Data",
    },
    {
      label: "Public art",
      detail: "PDC Outdoor Public Art · NYC Open Data, and OpenStreetMap",
    },
    {
      label: "Historic districts",
      detail: "LPC Historic Districts · NYC Landmarks Preservation Commission",
    },
    {
      label: "Industrial land",
      detail: "MapPLUTO · NYC Department of City Planning",
    },
    {
      label: "Building shade",
      detail: "NYC Building Footprints · NYC Open Data",
    },
    {
      label: "Scaffolding",
      detail:
        "Active Shed Permits · NYC DOB, and Digital Tax Map & condo billing lots · NYC Open Data",
    },
    {
      label: "Commercial streets",
      detail:
        "PLUTO, Dining Out & Open Streets · NYC Open Data, and OpenStreetMap",
    },
  ],
  sf: [
    {
      label: "Tree canopy",
      detail:
        "2013 Urban Forest Plan canopy analysis · SF Planning, and the 1 m LiDAR canopy height model for Alameda & Contra Costa · East Bay Regional Parks, CAL FIRE, USGS and Tukman Geospatial",
    },
    {
      label: "Street trees",
      detail:
        "SF Public Works street trees · DataSF, the Oakland Public Tree Inventory, and Berkeley's Arborwell street-tree survey",
    },
    // The East Bay half of the region is read from the county's own centreline, and this list is
    // the app's only credits surface, so both publishers are named rather than just the one whose
    // name was here when the region was San Francisco alone.
    {
      label: "Streets",
      detail:
        "SF Basemap Street Centerlines · DataSF, and Street Centerlines · Alameda County GIS",
    },
    // The boats are the only way a pedestrian crosses the bay, so the feed is routing input here
    // rather than scenery. Its ODC-BY is written down only on the operator's developer page, which
    // makes naming WETA the whole of what the license asks for.
    {
      label: "Ferries",
      detail: "San Francisco Bay Ferry GTFS · WETA (ODC-BY)",
    },
    // The land mask is a source in its own right here, and an unusual one: it is three publishers
    // subtracted and unioned rather than a layer anyone hands over. It reaches past the seven city
    // limits to the ridge parkland above Oakland, which no municipality contains — CPAD's own credit
    // wording is carried verbatim, as its terms ask.
    {
      label: "Land & parks",
      detail:
        "Analysis neighbourhoods · DataSF, city limits · Alameda County GIS, protected areas from the California Protected Areas Database (CPAD - www.calands.org). June 2024, and shoreline from US Census TIGER hydrography",
    },
    // SFMTA's feed license requires this wording verbatim on anything derived from it, so the detail
    // line carries it rather than paraphrasing.
    {
      label: "Transit lines",
      detail:
        "BART GTFS; Muni GTFS — reproduced with permission granted by the City and County of San Francisco, under a nonexclusive, limited and revocable license",
    },
    // The East Bay's landmarks are not a local register like San Francisco's: neither Oakland's nor
    // Berkeley's is published as data, so they come from the state's inventory and are federal and
    // state designations. The line says whose list it is, because the two are different claims.
    {
      label: "Landmarks",
      detail:
        "Article 10 landmark sites · SF Planning, and the Built Environment Resource Directory · California Office of Historic Preservation",
    },
    {
      label: "Public art",
      detail:
        "Civic Art Collection, the 1% Art Program inventory and StreetSmArts murals · DataSF, and OpenStreetMap",
    },
    {
      label: "Historic districts",
      detail:
        "Historic Districts · SF Planning, and the Cultural Heritage Survey's areas of primary importance and preservation zoning · City of Oakland",
    },
    {
      label: "Businesses",
      detail:
        "Legacy Business Registry · SF Office of Small Business, filtered to those trading 50+ years",
    },
    {
      label: "Industrial land",
      detail:
        "Land use and PDR zoning · SF Planning via DataSF, assessor parcel use codes · Alameda County GIS, and Existing Land Use 2020 · San Francisco Estuary Institute via MTC",
    },
    // Only San Francisco's own footprints arrive with a height on them. The East Bay's are
    // Overture's, and their heights were measured here off the county's raw point cloud, so both the
    // footprints' license and the flight that supplied the heights are named.
    {
      label: "Building shade",
      detail:
        "Building footprints with LiDAR heights · DataSF, and Overture Maps Foundation footprints (ODbL) with heights measured from the USGS 3DEP 2021 Alameda County LiDAR (public domain)",
    },
    {
      label: "Elevation",
      detail: "USGS 3DEP / NASA WERK 1 m surface models (CC0)",
    },
  ],
};

// Read by every city's map, so they sit under the city's own rather than being repeated in each.
export const SHARED_SOURCES: readonly DataSource[] = [
  // None of the Overture places theme is OpenStreetMap — it is Meta, Microsoft, Foursquare and
  // AllThePlaces — and CDLA-Permissive-2.0 asks that its text travel with the data rather than be
  // cited, so it does.
  //
  // The search index it goes into is NOT Overture alone, and both entries below say so. Alongside
  // the places it carries the names and points of the alleys, footbridges and park paths ADDR has no
  // addresses on, and those come out of the routing graph, which is an OSM extract. That makes
  // public/search a derivative database under ODbL, credited here as one. The permissive license is
  // untroubled by the company — it carries no share-alike of its own — but OSM is owed the credit
  // either way, and a file that quietly contains it while claiming not to is the worse outcome.
  {
    label: "Places",
    detail: "Overture Maps Foundation (CDLA-Permissive-2.0)",
    license: "licenses/CDLA-Permissive-2.0.txt",
  },
  {
    label: "Alley & park path names",
    detail: "OpenStreetMap contributors (ODbL)",
  },
  {
    label: "Place listings from Foursquare",
    detail: "© Foursquare Labs, Inc. (Apache-2.0) — NOTICE",
    license: "licenses/foursquare-places-NOTICE.txt",
  },
  {
    label: "Paths & street trees",
    detail: "OpenStreetMap contributors (ODbL)",
  },
  { label: "Highways & rail", detail: "OpenStreetMap contributors (ODbL)" },
  {
    label: "Basemap",
    detail: "Protomaps vector tiles · OpenStreetMap contributors, ODbL",
  },
  {
    label: "Map rendering",
    detail: "Leaflet (BSD-2-Clause) and protomaps-leaflet",
  },
];
