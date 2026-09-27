import { expect, test } from "bun:test";
import { roadTypeOf, sfTreeOf } from "./sf";
import { ROAD_PATH, ROAD_STREET, ROAD_TUNNEL } from "./streets";

test("the city's tunnels are walked as tunnels, sidewalks and all", () => {
  // Stockton and the two Broadway bores, which the centerline files as `TUNL`.
  expect(roadTypeOf({ layer: "STREETS", st_type: "TUNL" })).toBe(ROAD_TUNNEL);
  expect(roadTypeOf({ layer: "STREETS", st_type: "ST" })).toBe(ROAD_STREET);
  // An override never promotes a park path to a roadway.
  expect(roadTypeOf({ layer: "PARKS", st_type: "TUNL" })).toBe(ROAD_PATH);
});

test("a tree row reads the rebuilt register's species and trunk columns", () => {
  expect(
    sfTreeOf({
      latitude: "37.794364",
      longitude: "-122.433424",
      mapdbh: "9",
      species: "Ulmus parvifolia :: Chinese Elm",
      planttype: "Tree",
    }),
  ).toEqual({ lat: 37.794364, lng: -122.433424, dbhInches: 9, genus: "Ulmus" });
});

test("an unidentified or unmeasured tree keeps its place with no genus and a trunk to impute", () => {
  expect(
    sfTreeOf({ latitude: "37.7", longitude: "-122.4", species: "Tree(s) ::" }),
  ).toEqual({ lat: 37.7, lng: -122.4, dbhInches: 0, genus: "" });
  expect(
    sfTreeOf({
      latitude: "37.7",
      longitude: "-122.4",
      mapdbh: "0",
      species: ":: To Be Determine",
    }),
  ).toEqual({ lat: 37.7, lng: -122.4, dbhInches: 0, genus: "" });
  expect(sfTreeOf({ mapdbh: "12", species: "Ulmus :: Elm" })).toBeNull();
});

test("a species without a common name, or spelled in lowercase, still yields its genus", () => {
  const at = { latitude: "37.7", longitude: "-122.4" };
  expect(
    sfTreeOf({ ...at, species: "Magnolia grandiflora 'Little Gem'" })?.genus,
  ).toBe("Magnolia");
  expect(sfTreeOf({ ...at, species: "platanus hispanica" })?.genus).toBe(
    "Platanus",
  );
});
