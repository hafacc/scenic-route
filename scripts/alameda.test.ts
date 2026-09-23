import { expect, test } from "bun:test";
import { apnSortKey, featureName, prettyLandmarkName } from "./alameda";

// These join on exact strings, so a wrong spelling silently drops a landmark.

test("an APN is re-laid into the county's own key however the state spells it", () => {
  expect(apnSortKey("8 649 5")).toBe("008 064900500");
  expect(apnSortKey("070-0196-022")).toBe("070 019602200");
  expect(apnSortKey("071-0228-001-02")).toBe("071 022800102");
});

test("the padded key orders the books and pages numerically", () => {
  const keys = ["070-0196-022", "8 649 5", "071-0228-001-02"].map(apnSortKey);
  expect([...keys].sort()).toEqual([
    "008 064900500",
    "070 019602200",
    "071 022800102",
  ]);
});

test("a number that is not an APN is dropped rather than guessed at", () => {
  expect(apnSortKey("8 649")).toBeNull(); // no parcel group
  expect(apnSortKey("1234-0196-022")).toBeNull(); // book too wide
  expect(apnSortKey("")).toBeNull();
});

test("a street sheds the type token the address points keep in a column of their own", () => {
  expect(featureName("Shattuck Ave")).toBe("SHATTUCK");
  expect(featureName("Telegraph Ave.")).toBe("TELEGRAPH");
  expect(featureName("7th St")).toBe("7TH");
  // Terrace is part of this street's name.
  expect(featureName("Broadway Terrace")).toBe("BROADWAY TERRACE");
  // Berkeley files The Uplands under both words.
  expect(featureName("The Uplands")).toBe("THE UPLANDS");
});

test("the one street the two sources spell differently is reconciled", () => {
  expect(featureName("M L King Jr Wy")).toBe("MARTIN LUTHER KING JR");
  expect(featureName("Martin Luther King Jr Way")).toBe(
    "MARTIN LUTHER KING JR",
  );
});

test("a shouted landmark name is recased a letter run at a time", () => {
  expect(prettyLandmarkName("PARAMOUNT THEATRE")).toBe("Paramount Theatre");
  expect(prettyLandmarkName("U.S. POST OFFICE")).toBe("U.S. Post Office");
  expect(prettyLandmarkName("ST JOSEPH'S CHURCH")).toBe("St Joseph's Church");
  expect(prettyLandmarkName("  HOTEL   OAKLAND ")).toBe("Hotel Oakland");
});

test("a name somebody already capitalized is left alone, aliases and all", () => {
  expect(prettyLandmarkName("Thorsen, William R., House|Sigma Phi Place")).toBe(
    "Thorsen, William R., House",
  );
});

test("the export's editorial marks are not part of the name", () => {
  expect(prettyLandmarkName("FIRST CHURCH OF CHRIST, SCIENTIST~")).toBe(
    "First Church Of Christ, Scientist",
  );
  expect(prettyLandmarkName("OAKLAND CITY HALL<")).toBe("Oakland City Hall");
});
