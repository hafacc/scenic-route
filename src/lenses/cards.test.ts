import { describe, expect, test } from "bun:test";
import type { RouteFactors } from "../routing/search";
import {
  type CardChip,
  type CardShares,
  cardChips,
  cardColors,
  cardLine,
  cardShares,
  DIRECT_COLOR,
  ferrySummaries,
  rideSummaries,
} from "./cards";
import {
  ALL_FACTORS,
  DEFAULT_TOGGLES,
  effectiveWeights,
  type FactorAvailability,
  type Lens,
  lensById,
  type Toggles,
} from "./lenses";

const NATURALIST = lensById("naturalist");
const HISTORIC = lensById("historic");
const RAIN = lensById("rain");
if (NATURALIST === null || HISTORIC === null || RAIN === null) {
  throw new Error("the lenses these tests are about are gone");
}

const MILE = 1609.344;

const ride = (shortName: string, seconds: number) => ({
  shortName,
  color: "#0039a6",
  textColor: "#ffffff",
  seconds,
});

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

describe("ride segments", () => {
  test("a run of trains reads as the sum of each ride's own rounded minutes", () => {
    expect(
      cardLine({
        travelSeconds: 20 * 60,
        walkMeters: MILE,
        ferries: [],
        rides: [ride("A", 90), ride("L", 90)],
      }),
    ).toBe("20 min · 1.0 mi walk · 4 min on the A then L");
  });
});

describe("rideSummaries", () => {
  test("the minutes a card reports are the ride alone, as its step shows them", () => {
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
      { shortName: "Q", color: "#fccc0a", textColor: "#000000", seconds: 540 },
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
    expect(only.seconds).toBe(120);
    expect(
      cardLine({
        travelSeconds: 600,
        walkMeters: 400,
        ferries: [],
        rides: [only],
      }),
    ).toBe("10 min · 0.2 mi walk · 2 min on the train");
  });
});

describe("ferrySummaries", () => {
  test("the minutes a card reports are the crossing alone, the pier wait left to the total", () => {
    expect(
      ferrySummaries([
        {
          route: "Staten Island Ferry",
          waitSeconds: 9 * 60,
          crossingSeconds: 25 * 60,
          ridesBefore: 0,
          hops: 1,
          departureSeconds: 8 * 3600,
        },
      ]),
    ).toEqual([{ seconds: 25 * 60, ridesBefore: 0 }]);
  });

  test("the total is the whole trip, waits included, whatever the parts say", () => {
    const [ferry] = ferrySummaries([
      {
        route: "Staten Island Ferry",
        waitSeconds: 14 * 60,
        crossingSeconds: 25 * 60,
        ridesBefore: 0,
        hops: 1,
        departureSeconds: 8 * 3600,
      },
    ]);
    expect(
      cardLine({
        travelSeconds: 45 * 60,
        walkMeters: 400,
        ferries: [ferry],
        rides: [],
      }),
    ).toBe("45 min · 0.2 mi walk · 25 min by ferry");
  });
});

describe("cardColors", () => {
  const plain = (scenicScore: number) => ({ scenicScore, colorFactor: null });

  test("a lone card is the lens's own color", () => {
    expect(cardColors(HISTORIC, [plain(3)])).toEqual([HISTORIC.color]);
  });

  test("two cards are the lens's color and slate", () => {
    expect(cardColors(HISTORIC, [plain(1), plain(3)])).toEqual([
      DIRECT_COLOR,
      HISTORIC.color,
    ]);
  });

  test("a third card takes the first palette color the lens has not used", () => {
    // The historic palette leads with the lens's own brick, so the middle card takes the next.
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

  test("a route that stands out on one factor wears that factor's color", () => {
    const colors = cardColors(HISTORIC, [
      plain(4),
      { scenicScore: 3, colorFactor: "art" },
      plain(2),
      plain(1),
    ]);
    expect(colors[1]).toBe("#2552aa");
    expect(colors[2]).not.toBe("#2552aa");
    expect(colors).toEqual([
      HISTORIC.color,
      "#2552aa",
      HISTORIC.palette[1],
      DIRECT_COLOR,
    ]);
  });

  test("the ends keep their colors whatever they stand out on", () => {
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

  test("a standout in the accent's own color takes the palette instead", () => {
    expect(
      cardColors(NATURALIST, [
        plain(3),
        { scenicScore: 2, colorFactor: "tree" },
        plain(1),
      ]),
    ).toEqual([NATURALIST.color, NATURALIST.palette[0], DIRECT_COLOR]);
    expect(
      cardColors(HISTORIC, [
        plain(3),
        { scenicScore: 2, colorFactor: "historic" },
        plain(1),
      ]),
    ).toEqual([HISTORIC.color, HISTORIC.palette[1], DIRECT_COLOR]);
  });
});

const NO_FACTORS: RouteFactors = {
  tree: 0,
  shade: 0,
  landmark: 0,
  art: 0,
  highway: 0,
  hill: 0,
  commercial: 0,
  industrial: 0,
  historic: 0,
  bridge: 0,
  shelter: 0,
  ferry: 0,
};

const priced = (
  lens: Lens,
  toggles: Partial<Toggles> = {},
  available: FactorAvailability = ALL_FACTORS,
) => effectiveWeights(lens, { ...DEFAULT_TOGGLES, ...toggles }, available);

const keysOf = (chips: CardChip[][]) =>
  chips.map((card) => card.map((chip) => chip.key));

describe("cardChips, which factors", () => {
  const everything: CardShares = {
    ...Object.fromEntries(Object.keys(NO_FACTORS).map((key) => [key, 0.3])),
    familiar: 0.3,
    sheds: 0.3,
  };

  test("every priced factor chips, in the factors' order, ferry and subway left to the legs", () => {
    expect(keysOf(cardChips(priced(HISTORIC), [everything]))).toEqual([
      ["landmark", "art", "historic", "industrial", "bridge", "sheds"],
    ]);
    expect(keysOf(cardChips(priced(NATURALIST), [everything]))).toEqual([
      ["tree", "highway", "industrial", "bridge", "sheds"],
    ]);
  });

  test("scaffolding chips only where the lens routes around it", () => {
    expect(keysOf(cardChips(priced(RAIN), [everything]))).toEqual([
      ["shelter", "bridge"],
    ]);
  });

  test("the switches add sun, hills and familiar streets", () => {
    const walked = { ...ALL_FACTORS, familiar: true };
    expect(
      keysOf(
        cardChips(
          priced(
            RAIN,
            { sun: "shade", hills: "some", familiar: "new" },
            walked,
          ),
          [everything],
        ),
      ),
    ).toEqual([["shade", "shelter", "hill", "bridge", "unwalked"]]);
  });

  test("a factor the city cannot answer is not chipped", () => {
    const without = { ...ALL_FACTORS, art: false, hill: false };
    expect(
      keysOf(
        cardChips(priced(HISTORIC, { hills: "none" }, without), [everything]),
      ),
    ).toEqual([["landmark", "historic", "industrial", "bridge", "sheds"]]);
  });
});

describe("cardChips, numbers and bold", () => {
  test("a share reads as Explorer's number, rounded the way it prints", () => {
    expect(
      cardChips(priced(NATURALIST), [{ tree: 0.004 }, { tree: 0.006 }]),
    ).toEqual([[], [{ key: "tree", percent: 1, best: true }]]);
  });

  test("the most of a scenic factor is bold, every card that ties for it", () => {
    expect(
      cardChips(priced(NATURALIST), [
        { tree: 0 },
        { tree: 0.37 },
        { tree: 0.37 },
        { tree: 0.2 },
      ]),
    ).toEqual([
      [],
      [{ key: "tree", percent: 37, best: true }],
      [{ key: "tree", percent: 37, best: true }],
      [{ key: "tree", percent: 20, best: false }],
    ]);
  });

  test("the least of a penalty is bold, and none when a card has none of it", () => {
    expect(
      cardChips(priced(NATURALIST), [
        { industrial: 0.2, highway: 0.04 },
        { industrial: 0.05, highway: 0 },
      ]),
    ).toEqual([
      [
        { key: "highway", percent: 4, best: false },
        { key: "industrial", percent: 20, best: false },
      ],
      [{ key: "industrial", percent: 5, best: true }],
    ]);
  });

  test("hills read as the grade share, the flattest bold", () => {
    expect(
      cardChips(priced(RAIN, { hills: "none" }), [
        { hill: 0.4 },
        { hill: 0.05 },
        { hill: 0.3 },
      ]),
    ).toEqual([
      [{ key: "hill", percent: 40, best: false }],
      [{ key: "hill", percent: 5, best: true }],
      [{ key: "hill", percent: 30, best: false }],
    ]);
  });

  test("cards that all read the same have no bold", () => {
    expect(
      cardChips(priced(NATURALIST), [
        { tree: 0.2, highway: 0.1 },
        { tree: 0.2, highway: 0 },
        { tree: 0.2, highway: 0.1 },
      ]),
    ).toEqual([
      [
        { key: "tree", percent: 20, best: false },
        { key: "highway", percent: 10, best: false },
      ],
      [{ key: "tree", percent: 20, best: false }],
      [
        { key: "tree", percent: 20, best: false },
        { key: "highway", percent: 10, best: false },
      ],
    ]);
  });

  test("sun counts the sun either way, bold for the sunniest or the shadiest", () => {
    const shares = [{ shade: 0.3 }, { shade: 0.6 }];
    expect(cardChips(priced(RAIN, { sun: "sun" }), shares)).toEqual([
      [{ key: "shade", percent: 30, best: false }],
      [{ key: "shade", percent: 60, best: true }],
    ]);
    expect(cardChips(priced(RAIN, { sun: "shade" }), shares)).toEqual([
      [{ key: "shade", percent: 30, best: true }],
      [{ key: "shade", percent: 60, best: false }],
    ]);
  });

  test("in the rain the chip counts exposure, the driest bold, and no shelter isn't drawn", () => {
    expect(
      cardChips(priced(RAIN), [
        { shelter: 0 },
        { shelter: 0.31 },
        { shelter: 0.91 },
      ]),
    ).toEqual([
      [],
      [{ key: "shelter", percent: 69, best: false }],
      [{ key: "shelter", percent: 9, best: true }],
    ]);
  });

  test("familiar counts the walked share, new what the walks leave", () => {
    const walked = { ...ALL_FACTORS, familiar: true };
    const shares = [{ familiar: 0.25 }, { familiar: 0.8 }, { familiar: 1 }];
    expect(
      cardChips(priced(RAIN, { familiar: "familiar" }, walked), shares).map(
        (card) => card.filter((chip) => chip.key === "familiar"),
      ),
    ).toEqual([
      [{ key: "familiar", percent: 25, best: false }],
      [{ key: "familiar", percent: 80, best: false }],
      [{ key: "familiar", percent: 100, best: true }],
    ]);
    expect(
      cardChips(priced(RAIN, { familiar: "new" }, walked), shares).map((card) =>
        card.filter((chip) => chip.key === "unwalked"),
      ),
    ).toEqual([
      [{ key: "unwalked", percent: 75, best: true }],
      [{ key: "unwalked", percent: 20, best: false }],
      [],
    ]);
  });

  test("no walks here, no familiar chip", () => {
    expect(
      keysOf(
        cardChips(
          priced(
            RAIN,
            { familiar: "familiar" },
            { ...ALL_FACTORS, familiar: false },
          ),
          [{ familiar: 0.5 }],
        ),
      ),
    ).toEqual([[]]);
  });

  test("scaffolding still passed reads as its share, the least bold", () => {
    expect(
      cardChips(priced(NATURALIST), [{ sheds: 0.02 }, { sheds: 0.01 }]),
    ).toEqual([
      [{ key: "sheds", percent: 2, best: false }],
      [{ key: "sheds", percent: 1, best: true }],
    ]);
  });
});

describe("cardShares", () => {
  test("adds the walked share and the share under scaffolding", () => {
    const factors = { ...NO_FACTORS, tree: 0.5 };
    expect(cardShares({ factors, familiar: 0.4, sheds: 0.1 })).toEqual({
      ...factors,
      familiar: 0.4,
      sheds: 0.1,
    });
  });
});
