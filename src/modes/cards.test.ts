import { describe, expect, test } from "bun:test";
import {
  cardColors,
  cardLine,
  chipFactors,
  chipReading,
  DIRECT_COLOR,
  ferrySummaries,
  rideSummaries,
  visibleChips,
} from "./cards";
import { ALL_FACTORS, type FactorAvailability, modeById } from "./modes";

const NATURALIST = modeById("naturalist");
const HISTORIC = modeById("historic");
if (NATURALIST === null || HISTORIC === null) {
  throw new Error("the two modes these tests are about are gone");
}

const MILE = 1609.344;

const ride = (shortName: string, seconds: number) => ({
  shortName,
  color: "#0039a6",
  textColor: "#ffffff",
  seconds,
});

// A boat, and how many trains had been ridden before it — which is what orders the two.
const boat = (seconds: number, ridesBefore = 0) => ({ seconds, ridesBefore });

describe("cardLine", () => {
  test("a card reads as its own time and distance", () => {
    expect(
      cardLine({
        travelSeconds: 38 * 60,
        walkMeters: 1.9 * MILE,
        ferries: [],
        rides: [],
      }),
    ).toBe("38 min · 1.9 mi");
  });

  test("a slower card says what it takes, not what it costs", () => {
    expect(
      cardLine({
        travelSeconds: 47 * 60,
        walkMeters: 2.4 * MILE,
        ferries: [],
        rides: [],
      }),
    ).toBe("47 min · 2.4 mi");
  });

  test("a walk too short for a mile reads in feet, as its directions do", () => {
    expect(
      cardLine({
        travelSeconds: 150,
        walkMeters: 120,
        ferries: [],
        rides: [],
      }),
    ).toBe("3 min · 400 ft");
  });

  test("a ferry is timed rather than counted as mileage", () => {
    expect(
      cardLine({
        travelSeconds: 47 * 60,
        walkMeters: 2.4 * MILE,
        ferries: [boat(14 * 60)],
        rides: [],
      }),
    ).toBe("47 min · 2.4 mi walk · 14 min by ferry");
  });

  test("a ride names the line, and the mileage becomes the walk", () => {
    expect(
      cardLine({
        travelSeconds: 58 * 60,
        walkMeters: 1.2 * MILE,
        ferries: [],
        rides: [ride("A", 12 * 60)],
      }),
    ).toBe("58 min · 1.2 mi walk · 12 min on the A");
  });

  test("a change of trains is one figure and two names", () => {
    expect(
      cardLine({
        travelSeconds: 71 * 60,
        walkMeters: 0.8 * MILE,
        ferries: [],
        rides: [ride("A", 9 * 60), ride("L", 5 * 60)],
      }),
    ).toBe("71 min · 0.8 mi walk · 14 min on the A then L");
  });

  test("three trains read as a list", () => {
    expect(
      cardLine({
        travelSeconds: 80 * 60,
        walkMeters: MILE,
        ferries: [],
        rides: [ride("A", 60), ride("C", 60), ride("L", 60)],
      }),
    ).toBe("80 min · 1.0 mi walk · 3 min on the A, C then L");
  });

  test("a trip that takes both a boat and a train times each", () => {
    expect(
      cardLine({
        travelSeconds: 62 * 60,
        walkMeters: 1.0 * MILE,
        ferries: [boat(14 * 60)],
        rides: [ride("A", 9 * 60)],
      }),
    ).toBe("62 min · 1.0 mi walk · 14 min by ferry · 9 min on the A");
  });

  test("a boat caught after the train is said after it", () => {
    expect(
      cardLine({
        travelSeconds: 62 * 60,
        walkMeters: 1.0 * MILE,
        ferries: [boat(14 * 60, 1)],
        rides: [ride("A", 9 * 60)],
      }),
    ).toBe("62 min · 1.0 mi walk · 9 min on the A · 14 min by ferry");
  });

  test("a boat between two trains splits them, because that is the trip", () => {
    expect(
      cardLine({
        travelSeconds: 80 * 60,
        walkMeters: 1.0 * MILE,
        ferries: [boat(14 * 60, 1)],
        rides: [ride("A", 9 * 60), ride("L", 5 * 60)],
      }),
    ).toBe(
      "80 min · 1.0 mi walk · 9 min on the A · 14 min by ferry · 5 min on the L",
    );
  });

  test("Explorer leads with the mileage and says the same things after it", () => {
    expect(
      cardLine(
        {
          travelSeconds: 58 * 60,
          walkMeters: 1.2 * MILE,
          ferries: [],
          rides: [ride("A", 12 * 60)],
        },
        "distance",
      ),
    ).toBe("1.2 mi walk · 58 min · 12 min on the A");
  });
});

describe("rideSummaries", () => {
  test("the minutes a card reports are the wait plus the ride", () => {
    expect(
      rideSummaries([
        {
          route: {
            shortName: "Q",
            longName: "Broadway Express",
            id: "Q",
            color: "#fccc0a",
            textColor: "#000000",
          },
          boardStation: "Union Sq",
          alightStation: "Prospect Park",
          stops: 6,
          waitSeconds: 180,
          rideSeconds: 540,
          departureSeconds: 8 * 3600,
        },
      ]),
    ).toEqual([
      { shortName: "Q", color: "#fccc0a", textColor: "#000000", seconds: 720 },
    ]);
  });

  test("a ride whose route the graph cannot name is still a ride", () => {
    const [only] = rideSummaries([
      {
        route: null,
        boardStation: null,
        alightStation: null,
        stops: 2,
        waitSeconds: 60,
        rideSeconds: 120,
        departureSeconds: null,
      },
    ]);
    expect(only.shortName).toBe("");
    expect(only.seconds).toBe(180);
    expect(
      cardLine({
        travelSeconds: 600,
        walkMeters: 400,
        ferries: [],
        rides: [only],
      }),
    ).toBe("10 min · 0.2 mi walk · 3 min on the train");
  });
});

describe("ferrySummaries", () => {
  test("the minutes a card reports are the wait on the pier plus the crossing", () => {
    expect(
      ferrySummaries([
        {
          route: "Staten Island Ferry",
          waitSeconds: 9 * 60,
          crossingSeconds: 25 * 60,
          ridesBefore: 0,
        },
      ]),
    ).toEqual([{ seconds: 34 * 60, ridesBefore: 0 }]);
  });
});

describe("chips", () => {
  test("only the mode's own discounts, never its penalties", () => {
    // Naturalist prefers trees and avoids industry; the penalty is not a chip.
    expect(chipFactors(NATURALIST, ALL_FACTORS)).toEqual(["tree", "bridge"]);
    expect(chipFactors(HISTORIC, ALL_FACTORS)).toEqual([
      "landmark",
      "art",
      "historic",
      "bridge",
      "ferry",
    ]);
  });

  test("a factor the city cannot answer is not chipped", () => {
    const withoutArt: FactorAvailability = { ...ALL_FACTORS, art: false };
    expect(chipFactors(HISTORIC, withoutArt)).toEqual([
      "landmark",
      "historic",
      "bridge",
      "ferry",
    ]);
  });

  test("a city with no boat to catch is not offered the chip", () => {
    const withoutFerries: FactorAvailability = {
      ...ALL_FACTORS,
      ferry: false,
    };
    expect(chipFactors(HISTORIC, withoutFerries)).toEqual([
      "landmark",
      "art",
      "historic",
      "bridge",
    ]);
  });
});

describe("cardColors", () => {
  const plain = (scenicScore: number) => ({ scenicScore, colorFactor: null });

  test("a lone card is the mode's own colour", () => {
    expect(cardColors(HISTORIC, [plain(3)])).toEqual([HISTORIC.color]);
  });

  test("two cards are the mode's colour and slate", () => {
    expect(cardColors(HISTORIC, [plain(1), plain(3)])).toEqual([
      DIRECT_COLOR,
      HISTORIC.color,
    ]);
  });

  test("a third card takes the first palette colour the mode has not used", () => {
    // The historic palette leads with the mode's own indigo, so the middle card takes the next.
    expect(cardColors(HISTORIC, [plain(3), plain(2), plain(1)])).toEqual([
      HISTORIC.color,
      HISTORIC.palette[1],
      DIRECT_COLOR,
    ]);
  });

  test("four cards walk down the palette in order", () => {
    expect(
      cardColors(HISTORIC, [plain(4), plain(3), plain(2), plain(1)]),
    ).toEqual([
      HISTORIC.color,
      HISTORIC.palette[1],
      HISTORIC.palette[2],
      DIRECT_COLOR,
    ]);
  });

  test("a route that stands out on one factor wears that factor's colour", () => {
    const colors = cardColors(HISTORIC, [
      plain(4),
      { scenicScore: 3, colorFactor: "art" },
      plain(2),
      plain(1),
    ]);
    expect(colors[1]).toBe("#d946ef");
    // Art is spoken for, so the remaining middle card skips past it.
    expect(colors[2]).not.toBe("#d946ef");
    expect(colors).toEqual([
      HISTORIC.color,
      "#d946ef",
      HISTORIC.palette[1],
      DIRECT_COLOR,
    ]);
  });

  test("the ends keep their colours whatever they stand out on", () => {
    expect(
      cardColors(HISTORIC, [
        { scenicScore: 2, colorFactor: "art" },
        { scenicScore: 1, colorFactor: "landmark" },
      ]),
    ).toEqual([HISTORIC.color, DIRECT_COLOR]);
  });

  test("the naturalist palette is the canopy ramp's", () => {
    expect(cardColors(NATURALIST, [plain(3), plain(2), plain(1)])).toEqual([
      NATURALIST.color,
      NATURALIST.palette[0],
      DIRECT_COLOR,
    ]);
  });
});

describe("chipReading", () => {
  test("in the rain the chip counts what the shelter mean leaves out", () => {
    expect(chipReading("shelter", 91)).toEqual({ percent: 9, exposure: true });
  });

  test("the driest route is the least exposed one, so the bold card does not move", () => {
    const shelter = [91, 64, 40];
    const exposure = shelter.map(
      (mean) => chipReading("shelter", mean).percent,
    );
    expect(exposure).toEqual([9, 36, 60]);
    expect(exposure.indexOf(Math.min(...exposure))).toBe(
      shelter.indexOf(Math.max(...shelter)),
    );
  });

  test("every other factor reads as itself", () => {
    expect(chipReading("tree", 64)).toEqual({ percent: 64, exposure: false });
    expect(chipReading("shade", 12)).toEqual({ percent: 12, exposure: false });
  });
});

describe("visibleChips", () => {
  test("a factor a route has none of is not drawn at all", () => {
    expect(visibleChips(["tree", "art"], [{ tree: 0.42, art: 0 }])).toEqual([
      [{ key: "tree", percent: 42, best: true }],
    ]);
  });

  test("a chip is kept by what it would read, so it rounds the way it prints", () => {
    expect(visibleChips(["art"], [{ art: 0.004 }, { art: 0.006 }])).toEqual([
      [],
      [{ key: "art", percent: 1, best: true }],
    ]);
  });

  test("in the rain the raw shelter decides, not the exposure the chip shows", () => {
    expect(
      visibleChips(["shelter"], [{ shelter: 0 }, { shelter: 0.31 }]),
    ).toEqual([[], [{ key: "shelter", percent: 31, best: true }]]);
  });

  test("the bold card is the best of the ones still saying it", () => {
    expect(
      visibleChips(
        ["tree"],
        [{ tree: 0 }, { tree: 0.12 }, { tree: 0.37 }, { tree: 0.2 }],
      ),
    ).toEqual([
      [],
      [{ key: "tree", percent: 12, best: false }],
      [{ key: "tree", percent: 37, best: true }],
      [{ key: "tree", percent: 20, best: false }],
    ]);
  });

  test("a factor no card has leaves every card without it", () => {
    expect(visibleChips(["shade"], [{ shade: 0 }, {}])).toEqual([[], []]);
  });
});
