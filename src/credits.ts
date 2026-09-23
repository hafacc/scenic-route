// `license` is a license text the app must ship, not just name; it lives under public/licenses.
export interface DataSource {
  label: string;
  detail: string;
  license?: string;
}

// Per region so a license naming one city's terms (SFMTA's) stays attached to the map it governs.
export const CITY_SOURCES: Record<string, readonly DataSource[]> = {
  nyc: [
    {
      label: "Tree canopy",
      detail: "2017 LiDAR tree canopy · NYC OTI / NYC Parks",
    },
    // CC BY 4.0 makes this credit a license condition, and the map has no attribution control.
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
    {
      label: "Streets",
      detail:
        "SF Basemap Street Centerlines · DataSF, and Street Centerlines · Alameda County GIS",
    },
    // WETA's ODC-BY is only stated on its developer page; naming WETA is all it asks.
    {
      label: "Ferries",
      detail: "San Francisco Bay Ferry GTFS · WETA (ODC-BY)",
    },
    // CPAD's terms ask for its credit wording verbatim.
    {
      label: "Land & parks",
      detail:
        "Analysis Neighborhoods · DataSF, city limits · Alameda County GIS, protected areas from the California Protected Areas Database (CPAD - www.calands.org). June 2024, and shoreline from US Census TIGER hydrography",
    },
    // SFMTA's feed license requires this wording verbatim on anything derived from it.
    {
      label: "Transit lines",
      detail:
        "BART GTFS; Muni GTFS — reproduced with permission granted by the City and County of San Francisco, under a nonexclusive, limited and revocable license",
    },
    // Oakland's and Berkeley's registers aren't published as data, so these are state designations.
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
    // East Bay footprints are Overture's with heights measured here, so both sources are named.
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

export const SHARED_SOURCES: readonly DataSource[] = [
  // CDLA-Permissive-2.0 asks that its text travel with the data; the search index also holds OSM
  // path names, which makes it an ODbL derivative credited below.
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
