// Cost is effective seconds: an edge's raw travel time times a product of scenic factors. Each
// walked metre is discounted toward a floor by the tree cover, the landmarks and public art it
// passes, the nice commercial frontage it runs along, the designated historic district it runs
// inside, the open water it crosses on a bridge deck, and the shelter overhead (a factor
// 1 - w*attr per element) and made dearer by a nearby highway or elevated rail and by the
// industrial land it runs past (penalty factors 1 + w*attr); a
// ferry's crossing time is discounted by the ferry weight. The sun/shade axis is a single signed
// factor `1 - w*attr` whose weight `w in [-1, 1]` and edge attribute `attr in (-1, 1)` are both
// signed (attr positive = net sunlit, negative = net shaded, for the sun at the moment the edge is
// reached): w > 0 discounts sun and penalizes shade, w < 0 flips it, w = 0 is neutral. Every
// unsigned attribute byte is at most its graph-wide max, which the ingest clamps below 1, so every
// discount factor stays positive and the product never reaches 0 — no metre is ever free, so the
// search never wanders. The A* heuristic scales straight-line distance by `minMultiplier`, the product
// of each discount at its max (the penalty only raises cost, and the shade factor at its per-edge
// lower bound 1 - |w|*maxAbsAttr): a lower bound on any edge's multiplier, so the estimate never
// overestimates and the search stays optimal. INVARIANT: this holds only while each discount's max
// attribute stays < 1 (the ingest's 254 byte ceiling) and |w| <= 1 with maxAbsAttr < 1 for shade.
// Rail is priced outside all of that. A board edge costs the wait the day's timetable gives it plus
// a boarding constant, a ride edge its baked seconds, and both are multiplied by the transit penalty
// (1 + w) and by the shelter discount at attr = 1 — under cover, waiting included — and by nothing
// else: no shade, which is about being outside, and no scenic factor, none of which is a fact about
// a tunnel. The walk in and out of a station is plain seconds. The A* credit for a ride is in
// `transitCredit`.
// Scaffolding rides on top of that: a deck's share of an edge is sheltered from rain outright and
// shaded for as long as the sun has not slid its shadow off the sidewalk, whether or not the toggle
// bars scaffolding — a deck you were told to avoid is still overhead. Barring it adds a flat per-metre
// penalty on the decked share, which only raises the multiplier, so the heuristic still bounds it.
// A tunnel asserts both outright: sheltered to the byte ceiling every other attribute is clamped to,
// and in full shade at every instant. That is more shelter than a deck and a crown together reach, so
// `maxShelter` lifts the bound to it — on a graph that has a tunnel, and not on one that does not.

import {
  edgeKind,
  isTunnel,
  laneOf,
  type RoutingGraph,
  stopIndexOf,
  transitForward,
} from "./graph";
import { shedShade } from "./sheds";
import {
  edgeGrade,
  maxSpeedFactor,
  WALK_METERS_PER_SECOND,
  walkSecondsOf,
} from "./walk-speed";

// The walking-speed model lives in ./walk-speed so the graph can bake its seconds without reaching
// back into the cost model. Re-exported because everything that prices a walk asks this module.
export {
  edgeAscentGrade,
  edgeDescentGrade,
  edgeGrade,
  gradeSpeedFactor,
  maxSpeedFactor,
  WALK_METERS_PER_SECOND,
  walkSecondsPerMeter,
  walkSpeedOn,
} from "./walk-speed";

// What one crossing costs beyond walking its length. The same study's 50 timed walks over 18
// signalized blocks lost 75-155 s to crosswalks against 1,490-1,850 s of walking — about 3 s a
// crossing for walkers who cross on whichever leg is green rather than waiting out a full phase, and
// well under the ~15 s a compliant random arrival would face. Deliberately one number for every
// crossing: signalized share runs from 88% in midtown to 17% on Staten Island, but the whole term is
// worth a minute on a half-hour walk, so telling them apart buys less than it costs.
export const CROSSING_SECONDS = 3;

// What a crossing costs the ROUTER, as a multiple of the delay above, unless the reader has said the
// route may spend them freely. Nothing to do with how long a crossing takes — that is CROSSING_SECONDS and is what
// the ETA reports either way. This is a price on the act.
//
// The thing being priced out is a crossing that gets undone: over to the shady side of a block and
// straight back, which buys one block of better pavement for two crossings. A path cost cannot see
// "and straight back" — it has no memory — but it does not need to, because an undone crossing pays
// this twice for no progress. Pricing the act is the whole mechanism.
//
// 10x is 30 effective seconds. The floor is what a one-block detour buys: about 80 m of pavement at
// full discount saves in the order of 30 effective seconds, so a crossing has to cost more than half
// of that for the pair to stop being worth it. There is no matching ceiling — the alternative to
// crossing a street is going round the end of the block, which means crossing two OTHER streets, so
// raising this never makes a route go round the houses to avoid a crossing. It just stops buying
// them.
export const CROSSING_AVOID_MULTIPLE = 10;

// How long a walker will stand on a pier before the ferry stops counting as a way to get anywhere.
// The timetable always has a next sailing — tomorrow's first boat, if nothing else — so without a
// bound a route planned at midnight would propose waiting until morning. Past this the edge costs
// Infinity; that only ever raises cost, so the heuristic's ferry credit (built at zero wait) stays a
// lower bound.
//
// Per city, because what happens past the cap is not the same everywhere. In New York the search
// walks instead — the Staten Island Ferry runs every 30-60 minutes all night, and a bridge is always
// there. Across San Francisco Bay the ferry is the ONLY way over on foot, so past the cap is not
// "walk instead", it is "no route at all" — and the timetable has a 140-minute midday gap. Ninety
// minutes there tells a walker standing on the pier at 10:10 that they cannot get to Oakland, with a
// boat coming. The cost of a longer cap is a route that proposes a long wait; the cost of a short one
// is refusing a trip that is possible.
export const DEFAULT_MAX_FERRY_WAIT_SECONDS = 90 * 60;

// What getting on a train takes beyond waiting for it: down the stairs the timetable's clock does not
// run on, along the platform, through the doors. One number for every station, in the spirit of
// CROSSING_SECONDS — it varies with the station, and no walker knows theirs.
export const BOARDING_SECONDS = 60;

// How long a walker will stand on a platform before the train stops being a way to get anywhere.
// The same bargain the pier makes: the timetable always has a next train — tomorrow morning's, if
// nothing else — so without a bound a route planned at midnight would propose waiting for it. Half
// an hour, because a rail headway longer than that is a line running its night service, and past it
// the walk is the better answer. Per city, since a region whose rail is the only way through wants a
// longer one; New York and the Bay both take the default today.
export const DEFAULT_MAX_TRANSIT_WAIT_SECONDS = 30 * 60;

// Every weight spans [0, 1]. w must stay <= 1 or a discount floor (1 - w*max) can go negative, and a
// negative edge cost breaks Dijkstra/A*. Defaults sit a little in from the extremes for a mild bias.
export const MAX_TREE_WEIGHT = 1;
export const DEFAULT_TREE_WEIGHT = 0.8;
// A ferry costs FERRY_FLOOR of its duration at w = 1 (never free, so the search cannot loop a ferry
// for a heuristic credit). Defaults low — a stronger default over-favours ferries into odd detours.
export const MAX_FERRY_WEIGHT = 1;
export const DEFAULT_FERRY_WEIGHT = 0.1;
export const FERRY_FLOOR = 1e-3;
// Landmark and public-art discounts, and the highway/rail penalty. Modest defaults, tunable by eye.
export const MAX_LANDMARK_WEIGHT = 1;
export const DEFAULT_LANDMARK_WEIGHT = 0.1;
export const MAX_ART_WEIGHT = 1;
export const DEFAULT_ART_WEIGHT = 0.1;
// The third weight whose maximum is not 1, for the reason the other two are not: at 1 the slider
// ran out of authority while there was still highway left to avoid. Measured over 300 trips per
// city, seeded on streets fronting a highway and kept only where the slider-off route really walked
// one (at least 10% of its length). A ceiling of 1 left 22.9% of the walk on highway frontage
// against the ~15% the penalty can ever reach, and cost only 2.4% more walking to do it — two
// thirds of what was removable, for almost nothing. At 3 it reaches 17.8% for 6.1% more walking,
// which is about 90% of the attainable removal, and past 3 the frontage curve is flat while the
// distance one is not: 5 buys four more points of removal for four more points of walking, and the
// share of trips going 25% out of their way climbs from 4% at 1 to 21% at 8.
//
// New York and San Francisco agree on this to within a point of frontage at every setting. San
// Francisco pays one to two points more walking for it, having fewer parallel streets to escape
// onto, which argues for the low end of the knee rather than for a second number.
//
// The slider still reads 0-100% of this maximum, so raising it changes what the far end means, not
// how it is shown. Admissibility is untouched — a penalty's minimum factor is 1, and `minMultiplier`
// never sees it.
export const MAX_HIGHWAY_WEIGHT = 3;
// One of the two weights whose maximum is not 1 (industrial is the other), because at 1 the slider
// ran out of authority before it ran out of hill. Measured across Potrero Hill: at full strength the chosen route still climbed a block
// at or past 12% grade, and only at 2 did it stop using one at all (relief 614 m -> 431 m for 9%
// more walking). Past about 5 the routes stop changing much and start going a long way round, so
// that is where the top of the slider sits.
//
// The slider still reads 0-100%: a factor's percentage is taken against its own maximum, so this
// changes what the far end means and not how it is shown. Admissibility is untouched at any value —
// hill is a penalty, its minimum factor is 1, and `minMultiplier` never sees it.
export const MAX_HILL_WEIGHT = 5;

// The grade the hill slider is calibrated against: at this steepness the penalty is exactly the
// weight, which is where the Potrero measurements above were taken. Steeper costs more than
// proportionally and gentler costs less, because the penalty is SQUARED in the grade.
//
// That square is the whole point of the shape. A penalty proportional to grade is a penalty
// proportional to height climbed, so two routes that climb the same hill over the same distance cost
// the same however the climb is distributed — three flat blocks and one wall priced identically to
// four gradual ones. Squaring breaks the tie the way a walker would: spread the climb out and it
// costs less, concentrate it and it costs more.
const HILL_REFERENCE_GRADE = 0.12;

// Which way an edge is being walked, given the node it is entered by. The `-1` no-node default (and
// every test that passes it) means the stored a -> b direction.
export function edgeForward(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): boolean {
  return fromNode !== graph.edgeNodeB[edge];
}

// How much of the hill slider's authority an edge draws, 0 at flat and 1 at the reference grade.
// Clamped only for the summary's sake; the cost below deliberately runs past 1.
export function hillFractionOf(graph: RoutingGraph, edge: number): number {
  return Math.min(1, edgeGrade(graph, edge) / HILL_REFERENCE_GRADE);
}

// Unchanged by the raised ceiling above, so no existing route moves; it now reads 17% on the slider
// rather than 50%. It already clears the bar industrial set for its own default: 0.5 moves 64% of
// the seeded trips for 1.6% more walking, where industrial went to 1 because 0.5 moved under half.
export const DEFAULT_HIGHWAY_WEIGHT = 0.5;
// Hills start at zero, and now mean only what the name says: how much you MIND one, over and above
// the time it costs. The time is charged whatever the slider reads, because the walking speed itself
// is grade-adjusted — so a hilly route is reported as the longer walk it is, and the router prefers
// the flatter one at zero weight without being told to.
export const DEFAULT_HILL_WEIGHT = 0;
// A discount for edges fronting a nice commercial block. Modest default, tunable by eye.
export const MAX_COMMERCIAL_WEIGHT = 1;
export const DEFAULT_COMMERCIAL_WEIGHT = 0.1;
// A discount for walking inside a designated historic district. Parity with the landmark, art and
// commercial discounts, deliberately: it is the same kind of preference, and no measurement yet says
// otherwise. Note the attribute is close to binary — an interior sidewalk reads the 254 ceiling and
// only a boundary edge reads a part — so at w = 1 an in-district metre is nearly free and the
// heuristic floor nearly collapses. That is in-family (tree cover does it too) and admissible, since
// the byte ceiling keeps maxHistoric < 1; it is a reason to move this on measurements rather than to
// pre-inflate the maximum the way industrial's was.
export const MAX_HISTORIC_WEIGHT = 1;
export const DEFAULT_HISTORIC_WEIGHT = 0.1;
// A discount for the share of a walk that crosses open water on a bridge deck — the view off the
// Brooklyn Bridge, not the viaduct over the rail yard, which the graph's structure flag alone
// cannot tell apart and the bake's land mask does. Same family and same default as the two above:
// a taste, on no measurement yet. The attribute is near-binary (a mid-span edge reads the 254
// ceiling), so at w = 1 a metre over water is nearly free and the A* floor nearly collapses —
// in-family with tree cover and historic, and admissible while the ceiling keeps maxBridge < 1.
export const MAX_BRIDGE_WEIGHT = 1;
export const DEFAULT_BRIDGE_WEIGHT = 0.1;
// A penalty for edges running past industrial land, in the highway family. The top of the slider sits
// where hill's does, and for the same reason: measured over 234 trips seeded on industrial streets, a
// ceiling of 1 left a third of them on exactly the route they took with the slider off and removed
// only 40% of the industrial frontage walked (17.2% -> 10.4%). The saturated districts moved
// dramatically at that setting, which is what made it look sufficient; the middle of the distribution
// did not. At 5 it reaches 5.1% for 14.5% more walking, and past that routes go a long way round.
//
// The slider still reads 0-100% of this maximum, so raising it changes what the far end means, not
// how it is shown. Admissibility is untouched — a penalty's minimum factor is 1, and `minMultiplier`
// never sees it.
export const MAX_INDUSTRIAL_WEIGHT = 5;
// The penalty on time spent waiting for and riding a train, in the highway/industrial family: a
// second on the A costs 1 + w seconds. The whole point of this app is the walk, so every mode but
// Rain carries the top of the slider, where a ride costs four times its own minutes — enough that a
// walkable trip is walked, and not so much that a rail-length trip refuses the rail.
export const MAX_TRANSIT_WEIGHT = 3;
// Explorer opens at the top of it for the same reason: a scenic walking route that puts you
// underground unasked has answered a question nobody put to it.
export const DEFAULT_TRANSIT_WEIGHT = MAX_TRANSIT_WEIGHT;
// 1 rather than highway's 0.5: it moves 63% of those trips for 3.6% more walking, where 0.5 moves
// under half. Reads as 20% on the slider.
export const DEFAULT_INDUSTRIAL_WEIGHT = 1;
// The signed sun/shade axis spans [-1, 1] (0 = no preference): positive prefers sun, negative prefers
// shade. |w| <= 1 keeps the shade factor's floor (1 - |w|*maxAbsAttr) positive since maxAbsAttr < 1.
export const MAX_SHADE_WEIGHT = 1;
export const DEFAULT_SHADE_WEIGHT = 0;
// Shelter from rain: a scaffolding deck plus the canopy directly overhead. Off by default — it is a
// preference for the days it is raining, not a standing bias.
export const MAX_SHELTER_WEIGHT = 1;
export const DEFAULT_SHELTER_WEIGHT = 0;

// What a tunnel shelters, as a share of a walked metre. The byte ceiling every baked discount
// attribute is clamped to rather than a flat 1, so the shelter factor keeps a positive floor and no
// metre of the network is ever free — the invariant at the top of this file.
export const TUNNEL_SHELTER = 254 / 255;

// What a metre under a deck costs while scaffolding is barred, as a multiple of walking it. Dodging
// scaffolding means crossing the street, and you cannot cross mid-block, so the real detour is
// corner-cross-back: up to about a block (~160 m) to miss maybe 40 m of deck. That breaks even near
// 4x, so this sits far enough above it that the detour is taken whenever one exists. Finite on
// purpose — a start or destination under scaffolding stays routable, and a penalty every candidate
// path has to pay cannot change which of them wins.
export const SHED_AVOID_PENALTY = 20;

// A cover gap (0..255) at or under this reads as "too close to call" (~5% cover) — the threshold
// Phase 3 directions use before bothering to name a greener side.
export const SIDE_TIE_BYTES = 12;

// The full cost context a search runs against: the scenic weights and the gates.
// The switches, as data. Everything that has to enumerate them — the cache's staleness check, the
// settings page, the panel's header — reads this rather than writing the list out again, because a
// list written out again is a list that can miss one. It has: the crossing gate was added and the
// route cache went on comparing the other two, so flipping it changed nothing on screen.
export const GATE_KEYS = [
  "allowSheds",
  "allowFerries",
  "allowCrossings",
] as const;

export type GateKey = (typeof GATE_KEYS)[number];

// A switch with no toggle behind it: the planner shuts it to ask for the walk it will offer beside a
// ride, and nothing else ever moves it. It is not a gate — a gate is a control the reader has, and
// this is not — and it is not a weight, so it is excluded from the factor list the way the gates are
// and compared like them where a route's context is compared.
export const INTERNAL_FLAGS = ["allowTransit"] as const;

export type InternalFlag = (typeof INTERNAL_FLAGS)[number];

// The factors that DISCOUNT a walked metre (a `1 - w*attr` term in `edgeMultiplier`) rather than
// price it (`1 + w*attr`). `ferry` is in neither: it discounts a crossing's seconds, not a metre.
export const DISCOUNT_KEYS = [
  "tree",
  "landmark",
  "art",
  "commercial",
  "historic",
  "bridge",
  "shade",
  "shelter",
] as const;

export type DiscountKey = (typeof DISCOUNT_KEYS)[number];

// What a card can say a route HAS: the metre discounts, plus the boat — whose discount is on a
// crossing's seconds rather than on a metre, and which is scenery all the same.
export const SCENIC_KEYS = [...DISCOUNT_KEYS, "ferry"] as const;

export type ScenicKey = (typeof SCENIC_KEYS)[number];

// The factors that PRICE what they touch (a `1 + w*attr` term, or the penalty on a train's seconds)
// rather than discount it. None can make a second cheaper, so the A* lower bound never sees one.
export const PENALTY_KEYS = [
  "highway",
  "hill",
  "industrial",
  "transit",
] as const;

export type PenaltyKey = (typeof PENALTY_KEYS)[number];

// Every weight that is a number, which is every axis a slider can move: RouteWeights without the
// gates and the planner's own flag.
export type WeightKey = Exclude<keyof RouteWeights, GateKey | InternalFlag>;

// All of them, in one list, so the route cache's axes and the heuristic's floor are read off the
// same place the panel is.
export const WEIGHT_KEYS = [...SCENIC_KEYS, ...PENALTY_KEYS] as const;

type Listed = (typeof WEIGHT_KEYS)[number];

// The compiler's own check that the lists above are exactly the numeric weights: a factor added to
// RouteWeights and not to one of them — or listed twice over — leaves a key here, which fails the
// constraint. Adding `bridge` touched thirteen files, and the two it MISSED were silent.
type NoStrays<Key extends never> = Key;

export type WeightListsAreComplete = NoStrays<
  Exclude<WeightKey, Listed> | Exclude<Listed, WeightKey>
>;

export interface RouteWeights {
  tree: number;
  ferry: number;
  landmark: number;
  art: number;
  highway: number;
  // Penalty for climbing: how much a walker minds a hill. Absolute, so it costs the same up or
  // down — a route that avoids a hill avoids it in both directions.
  hill: number;
  commercial: number;
  // Penalty for walking past industrial land: the share of the edge's length with a yard or a
  // warehouse beside it, counted per side, so both sides cost twice one.
  industrial: number;
  // Discount for walking inside a designated historic district: the share of the edge's length that
  // falls within one. Independent of `landmark`, which prices passing an individual monument.
  historic: number;
  // Discount for crossing open water on a bridge deck: the share of the edge's length that does.
  bridge: number;
  shade: number; // signed sun/shade preference in [-1, 1]; positive prefers sun, negative shade
  shelter: number; // preference for cover overhead in the rain: decks and canopy
  // Penalty on the seconds a train takes — the wait on the platform and the ride itself. Not a
  // distaste for trains as such: it is what keeps a walking route walking, and backing it off is how
  // the planner offers "take the subway" as one of its cards.
  transit: number;
  allowFerries: boolean;
  // False skips every board edge, so no route gets on a train. Not a reader's switch: the planner
  // turns it off for one candidate so a mode that prices no ride at all still offers the walk.
  allowTransit: boolean;
  allowSheds: boolean; // false routes around scaffolding, at a large per-metre penalty
  // Whether the route may spend crossings freely to reach what it is looking for. False — the
  // default — prices every crossing far above what it takes to walk, which is what stops a route
  // zigzagging across a street to chase the shady side and straight back. See
  // CROSSING_AVOID_MULTIPLE.
  allowCrossings: boolean;
}

// This edge's own cover, 0..1. In v2 the side is topology, so an edge carries a single value.
export function edgeCover(graph: RoutingGraph, edge: number): number {
  return graph.edgeCover[edge] / 255;
}

// The share of this edge standing under a scaffolding deck, 0 while no shed artifact is loaded.
export function edgeShed(graph: RoutingGraph, edge: number): number {
  return graph.sheds ? graph.sheds.coverage[edge] / 255 : 0;
}

// `edgeShed` damped by how far the sun has slid the deck's shadow off the sidewalk (shedShade in
// src/routing/sheds.ts). 0 while no shed artifact is loaded.
export function edgeShedShade(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
): number {
  return graph.sheds ? shedShade(graph.sheds, edge, elapsedSeconds) : 0;
}

// The signed sun/shade attribute for the sun at this point in the walk, with `shed` of the edge shaded
// by a deck. A deck is opaque, so the share it shades reads shaded whatever the sky is doing while the
// rest keeps what was baked — and since both are length fractions of the same edge the two mix rather
// than stack. That mix is `1 - (1 - bakedShade)(1 - shed)` written on the signed attribute, which reads
// -intensity where an edge is fully shaded. 0 when no artifact is loaded or the sun is down.
//
// A tunnel is that same full shade, whatever the sky is doing and whatever covers the street above.
export function shadeAttrOf(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
  shed: number,
): number {
  if (!graph.shade) {
    return 0;
  } else if (graph.hasTunnels && isTunnel(graph, edge)) {
    return -graph.shade.intensityAt(elapsedSeconds);
  } else if (shed === 0) {
    return graph.shade.attrAt(edge, elapsedSeconds);
  } else {
    return (
      graph.shade.attrAt(edge, elapsedSeconds) * (1 - shed) -
      shed * graph.shade.intensityAt(elapsedSeconds)
    );
  }
}

// How much of a walked metre of this edge has something over it in the rain: the deck outright, plus
// the crowns over the share with no deck under them. Both are fractions of the edge's length, so this
// is a union of coverage rather than a stack of opacities, and the `1 - shed` is the assumption that
// the two are spread independently along the edge.
//
// A tunnel is the byte ceiling of it, and is so in a city with no shed feed: the roof is the ground
// above.
export function shelterAttrOf(
  graph: RoutingGraph,
  edge: number,
  shed: number,
): number {
  if (graph.hasTunnels && isTunnel(graph, edge)) {
    return TUNNEL_SHELTER;
  } else if (!graph.sheds) {
    return 0;
  } else {
    const canopy =
      graph.sheds.rainTau * (graph.edgeDirectCanopy[edge] / 255) * (1 - shed);
    return shed + canopy;
  }
}

// The most shelter an edge can offer: a tunnel outright, else fully decked, or crowns over whatever a
// deck does not cover. A deck, a crown and a tunnel all sit under the same byte ceiling, so this
// stays < 1 and the shelter factor's floor stays positive at every weight.
export function maxShelter(graph: RoutingGraph): number {
  const tunnel = graph.hasTunnels ? TUNNEL_SHELTER : 0;
  if (!graph.sheds) {
    return tunnel;
  } else {
    const { maxCoverage, rainTau } = graph.sheds;
    const decked =
      maxCoverage + rainTau * graph.maxDirectCanopy * (1 - maxCoverage);
    return Math.max(tunnel, decked);
  }
}

// The walking multiplier: the tree-cover, landmark, art, commercial, historic-district and
// bridge-over-water discounts (each 1 - w*attr) and the signed sun/shade factor (1 - w*attr, attr and w both signed) times the
// nuisance penalty (1 + w*attr). At every weight 0 this is 1 (the shortest path); a shaded,
// landmarked metre far from any highway approaches the floor. No per-factor clip is needed — each unsigned attribute is <= its graph max, and
// the shade factor is >= its `minMultiplier` term 1 - |w|*maxAbsAttr, so the product stays positive.
// `elapsedSeconds` is how far into the walk the edge is reached; the shade field advances the sun by it,
// so the same edge costs differently early vs late in a long route. It defaults to the departure instant.
export function edgeMultiplier(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
): number {
  const shed = edgeShed(graph, edge);
  // Shelter is the deck's whole coverage — a roof keeps rain off from any angle — but shade is only
  // what its 4 m depth still covers once the sun has slid the shadow sideways. Both count whether or
  // not scaffolding is barred: a deck nobody wants to walk under still shelters and still shades the
  // ground it stands over, which is how the route summary reports it too.
  const shaded = edgeShedShade(graph, edge, elapsedSeconds);
  const tree = 1 - weights.tree * (graph.edgeCover[edge] / 255);
  const landmark = 1 - weights.landmark * (graph.edgeLandmark[edge] / 255);
  const art = 1 - weights.art * (graph.edgeArt[edge] / 255);
  const highway = 1 + weights.highway * (graph.edgeHighway[edge] / 255);
  // Squared, so the same climb spread over a longer stretch costs less than the same climb
  // concentrated into a wall; `HILL_REFERENCE_GRADE` carries the reasoning. Unclamped above the
  // reference — San Francisco has streets at three times it, and they should cost like it.
  const gradeShare = edgeGrade(graph, edge) / HILL_REFERENCE_GRADE;
  const hill = 1 + weights.hill * gradeShare * gradeShare;
  const commercial =
    1 - weights.commercial * (graph.edgeCommercial[edge] / 255);
  const industrial =
    1 + weights.industrial * (graph.edgeIndustrial[edge] / 255);
  const historic = 1 - weights.historic * (graph.edgeHistoric[edge] / 255);
  const bridge = 1 - weights.bridge * (graph.edgeBridge[edge] / 255);
  // The signed shade attribute for the sun at this point in the walk; 0 when no artifact is loaded or at
  // night. The field ignores elapsed time for a fixed sun position (constant field, tests).
  const shade =
    1 - weights.shade * shadeAttrOf(graph, edge, elapsedSeconds, shaded);
  const shelter = 1 - weights.shelter * shelterAttrOf(graph, edge, shed);
  const scenic =
    tree *
    landmark *
    art *
    highway *
    hill *
    commercial *
    industrial *
    historic *
    bridge *
    shade *
    shelter;
  if (weights.allowSheds) {
    return scenic;
  } else {
    // Charged per metre, not per edge: a deck over a tenth of an edge must not price the whole of it.
    // The decked share costs an undiscounted metre plus the whole penalty however sure the placement
    // is — a shed that might be there is a reason to walk elsewhere, not a reason to walk under it —
    // and the bare share is costed as the bare sidewalk it is.
    return scenic * (1 - shed) + shed + SHED_AVOID_PENALTY * shed;
  }
}

// The least a walked metre's multiplier can be: the product of each discount at the graph's max
// attribute (the penalty only raises cost, so its minimum factor is 1). A lower bound on every edge's
// multiplier — possibly loose, since one edge need not max every discount at once — so the A* heuristic
// that scales straight-line distance by it never overestimates. Positive because each max < 1.
export function minMultiplier(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  let product = 1;
  for (const key of DISCOUNT_KEYS) {
    // Shade's weight is the signed one: whichever sign of attr it discounts, its floor is at the
    // field's greatest magnitude over every edge and elapsed time. Positive because |shade| <= 1 and
    // maxAbs < 1. Compositing a deck in cannot leave that range: it mixes the baked attribute toward
    // -intensity, and the field's intensity is bounded by the same maxAbs. A tunnel reads exactly
    // -intensity, so it is inside it too.
    product *= 1 - Math.abs(weights[key]) * discountMax(graph, key);
  }
  return product;
}

// The greatest this discount's attribute reaches anywhere on the graph: what the bound above clips
// against, and what a card's lead over the other routes is measured against. The switch is the list:
// a discount added without a maximum here does not compile.
export function discountMax(graph: RoutingGraph, key: DiscountKey): number {
  switch (key) {
    case "tree":
      return graph.maxCover;
    case "landmark":
      return graph.maxLandmark;
    case "art":
      return graph.maxArt;
    case "commercial":
      return graph.maxCommercial;
    case "historic":
      return graph.maxHistoric;
    case "bridge":
      return graph.maxBridge;
    case "shade":
      return graph.shade ? graph.shade.maxAbs : 0;
    case "shelter":
      return maxShelter(graph);
  }
}

// The wait this edge owes, charged where a walker steps off the kerb and nowhere else. A divided
// street is several crossing edges chained through its islands, so `fromNode` — the node the walker
// enters by — is what separates the start of a crossing from its continuation.
export function crossingWait(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): number {
  return edgeKind(graph, edge) === "crossing" &&
    graph.nodeMidRoadway[fromNode] === 0
    ? CROSSING_SECONDS
    : 0;
}

// What riding a ferry takes, boarding at `fromNode` after `elapsedSeconds` of walking: the wait for
// the next sailing out of that terminal plus its crossing. Infinity once the day's last boat has gone,
// which is what drops the edge out of the search rather than pricing a walk to a dark terminal.
// Without a timetable loaded it is the graph's baked crossing-plus-average-wait figure, which is
// direction- and time-independent — the behaviour before FSCH existed.
export function ferrySeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds: number,
): { wait: number; crossing: number } {
  if (!graph.ferries?.covers(edge)) {
    return { wait: 0, crossing: graph.edgeDurationSeconds[edge] };
  }
  const sailing = graph.ferries.board(edge, fromNode, elapsedSeconds);
  const cap = graph.maxFerryWaitSeconds ?? DEFAULT_MAX_FERRY_WAIT_SECONDS;
  if (!sailing || sailing.wait > cap) {
    return { wait: Number.POSITIVE_INFINITY, crossing: 0 };
  } else {
    return { wait: sailing.wait, crossing: sailing.crossing };
  }
}

// What getting on a train at this platform takes, `elapsedSeconds` into the walk: the wait for the
// next departure of the lane the board edge names, plus the boarding constant. Infinity once the
// day's last train has gone or the wait runs past the cap, which drops the edge out of the search
// rather than pricing a walk to a dark platform.
//
// Infinity too when there is no timetable at all — a day no record covers, or a fetch that failed.
// The graph bakes a board edge no duration to fall back on, and inventing an average headway would
// be putting a walker on a train nobody has said runs: no schedule, no train.
export function boardSeconds(
  graph: RoutingGraph,
  edge: number,
  elapsedSeconds: number,
): number {
  const lane = laneOf(graph, edge);
  if (!graph.transit?.covers(lane)) {
    return Number.POSITIVE_INFINITY;
  }
  const departure = graph.transit.board(
    lane,
    stopIndexOf(graph, edge),
    elapsedSeconds,
  );
  const cap = graph.maxTransitWaitSeconds ?? DEFAULT_MAX_TRANSIT_WAIT_SECONDS;
  if (!departure || departure.wait > cap) {
    return Number.POSITIVE_INFINITY;
  } else {
    return departure.wait + BOARDING_SECONDS;
  }
}

// What a second of transit costs: the transit penalty on it, discounted by the shelter preference at
// attr = 1 — a train and the platform it leaves from are both under cover, waiting included. Floored
// the way a ferry's crossing is, so no amount of shelter preference makes a ride free and no route
// can ride in circles for a heuristic credit. Nothing else touches it: not the shade term, which is
// about being outside, and not any other scenic factor, none of which is a fact about a tunnel.
export function transitMultiplier(weights: RouteWeights): number {
  return (1 + weights.transit) * Math.max(FERRY_FLOOR, 1 - weights.shelter);
}

// What a second on the water costs: the taste for a boat and the taste for a roof, both floored the
// way `transitMultiplier` is so a crossing is never free.
export function ferryCrossingDiscount(weights: RouteWeights): number {
  return (
    Math.max(FERRY_FLOOR, 1 - weights.ferry) *
    Math.max(FERRY_FLOOR, 1 - weights.shelter)
  );
}

// The undiscounted travel time of an edge entered at `fromNode` after `elapsedSeconds` of walking: a
// ferry's wait-plus-crossing, a transit edge's own seconds (the wait for a board edge, the baked
// ride or station walk for the other two), or a walked edge's length over walking speed plus any
// crossing wait. This is the ETA unit — the reported trip time sums it.
export function rawSeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  elapsedSeconds = 0,
): number {
  const kind = edgeKind(graph, edge);
  if (kind === "ferry") {
    const { wait, crossing } = ferrySeconds(
      graph,
      edge,
      fromNode,
      elapsedSeconds,
    );
    return wait + crossing;
  } else if (kind === "board") {
    return boardSeconds(graph, edge, elapsedSeconds);
  } else if (kind === "ride" || kind === "access") {
    return graph.edgeDurationSeconds[edge];
  } else {
    return (
      walkedSeconds(graph, edge, fromNode) + crossingWait(graph, edge, fromNode)
    );
  }
}

// The baked seconds to walk one whole edge, entered at `fromNode`. A partial walk — the two end
// edges of a route — is not this: it is its own length over the edge's speed.
function walkedSeconds(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
): number {
  const baked = walkSecondsOf(graph);
  return edgeForward(graph, edge, fromNode)
    ? baked.forward[edge]
    : baked.backward[edge];
}

// Both prices of one step: what the search costs it at, and what the walker's clock advances by.
// A boat's sailing and a train's departure are timetable lookups, and the relax loop wants both
// figures off a single one of them. Written into a record the caller owns, so the loop allocates
// nothing per edge it relaxes.
export interface EdgeSeconds {
  effective: number;
  raw: number;
}

export function edgeSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds: number,
  fromNode: number,
  into: EdgeSeconds,
): void {
  const kind = edgeKind(graph, edge);
  if (kind === "board" || kind === "ride" || kind === "access") {
    // The topology is directed, and the graph is not: refusing the reverse here is what stops a
    // route riding a train backwards or stepping onto a platform through an alight edge. A step that
    // costs Infinity is never taken, so its raw seconds go unasked for — which is what keeps an
    // alight edge from costing a timetable lookup every time the frontier sweeps past it.
    if (
      !transitForward(graph, edge, fromNode) ||
      (kind === "board" && !weights.allowTransit)
    ) {
      into.raw = 0;
      into.effective = Number.POSITIVE_INFINITY;
    } else if (kind === "access") {
      into.raw = graph.edgeDurationSeconds[edge];
      into.effective = into.raw; // the walk in and out of a station, priced plainly
    } else {
      into.raw =
        kind === "board"
          ? boardSeconds(graph, edge, elapsedSeconds)
          : graph.edgeDurationSeconds[edge];
      into.effective = into.raw * transitMultiplier(weights);
    }
  } else if (kind === "ferry") {
    if (!weights.allowFerries) {
      into.raw = 0;
      into.effective = Number.POSITIVE_INFINITY;
    } else {
      const { wait, crossing } = ferrySeconds(
        graph,
        edge,
        fromNode,
        elapsedSeconds,
      );
      into.raw = wait + crossing;
      // The ferry weight is a taste for BEING on a boat, so it discounts the crossing and leaves the
      // wait at full price — otherwise a strong preference would make standing on a pier cheap, and
      // the router would pick the later sailing. The baked figure has the two fused and is
      // discounted whole, which is the closest it can come.
      //
      // The shelter preference splits the same way, and for the same reason it is the crossing that
      // gets it: a boat has a cabin and a pier does not.
      into.effective = wait + crossing * ferryCrossingDiscount(weights);
    }
  } else {
    const walked = walkedSeconds(graph, edge, fromNode);
    into.raw = walked + crossingWait(graph, edge, fromNode);
    // The crossing price is added AFTER the multiplier, not multiplied by it: it is a price on
    // crossing rather than a property of the pavement, and a strong shade preference discounting it
    // is exactly the thing it exists to stop.
    into.effective =
      walked * edgeMultiplier(graph, edge, weights, elapsedSeconds) +
      crossingPrice(graph, edge, fromNode, weights);
  }
}

const oneEdge: EdgeSeconds = { effective: 0, raw: 0 };

// Cost is effective seconds: raw time times the clipped discount. A ferry discounts by the ferry
// weight (unusable when ferries are barred); every walked edge by the scenic multiplier above.
// `elapsedSeconds` — how far into the walk the edge is reached — advances the sun for the shade factor;
// it defaults to the departure instant (a ferry's cost is time-independent, so it ignores it).
export function effSeconds(
  graph: RoutingGraph,
  edge: number,
  weights: RouteWeights,
  elapsedSeconds = 0,
  fromNode = -1,
): number {
  edgeSeconds(graph, edge, weights, elapsedSeconds, fromNode, oneEdge);
  return oneEdge.effective;
}

// What this edge adds for being a crossing. Zero once crossings are allowed freely, and otherwise
// charged through `crossingWait`, so a divided street chained through its island is priced once
// rather than once per carriageway.
export function crossingPrice(
  graph: RoutingGraph,
  edge: number,
  fromNode: number,
  weights: RouteWeights,
): number {
  return weights.allowCrossings
    ? 0
    : crossingWait(graph, edge, fromNode) * CROSSING_AVOID_MULTIPLE;
}

// The least seconds a walked metre can cost — the min multiplier over walking speed. The A* heuristic
// scales straight-line distance by this: a lower bound on remaining walking time.
export function walkSecondsCoeff(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  // Divided by the fastest speed any edge in the graph can be walked at, which a gentle descent puts
  // above the flat 1.3 m/s — so this stays a LOWER bound on the seconds a metre costs, which is all
  // the heuristic needs.
  return (
    minMultiplier(graph, weights) /
    (WALK_METERS_PER_SECOND * maxSpeedFactor(graph))
  );
}

// The most seconds a route can save by riding instead of walking: per transit edge, the walking
// floor for its span less the least that edge can cost, summed over EVERY one of them in the city.
//
// Why the sum is over all of them, and why it is admissible. The heuristic is
// `coeff × straight-line − credit`; the straight line is at most the length of any path, so it is
// enough that the credit covers `Σ (coeff × length − cost)` over that path's edges. A walked edge's
// term is at most 0 by the definition of `coeff`. A ride's is positive — that is what a train is —
// and so, less obviously, is a long station walk's: a 250 m access edge costs its baked 90 seconds
// however far it runs. Both are in this sum, every term is non-negative, and the path's transit
// edges are a subset of the city's, so the sum is at least the path's saving whatever chain of
// rides and transfers it takes.
//
// The wait is taken as zero, which is a true lower bound over every departure time and only makes
// the credit looser. Loose is the price of the shape: at a low transit penalty the credit swamps the
// straight-line term on its own, which is why the caller keeps `heuristicFloor` under it.
//
// Zero with no timetable loaded: every board edge then costs Infinity, so no route rides and there
// is nothing to credit.
export function transitCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (
    !weights.allowTransit ||
    graph.transit === null ||
    graph.boardEdges.length === 0
  ) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  const multiplier = transitMultiplier(weights);
  let credit = 0;
  for (const edge of graph.transitEdges) {
    // A board edge only spans anything inside a transfer complex, where the station node is the
    // members' centroid and the platform stands on its own stop; the wait it costs is not bounded
    // below by anything, so its whole span counts as a saving.
    const kind = edgeKind(graph, edge);
    const cheapest =
      kind === "ride"
        ? graph.edgeDurationSeconds[edge] * multiplier
        : kind === "access"
          ? graph.edgeDurationSeconds[edge]
          : 0;
    credit += Math.max(0, coeff * graph.edgeLength[edge] - cheapest);
  }
  return credit;
}

// The most seconds a route can save by riding instead of walking the water: per ferry edge, the
// walking floor for its chord less the least that crossing can cost, summed over EVERY ferry edge in
// the city. Zero when ferries are barred or the graph has none.
//
// Why the sum is over all of them, and why it is admissible. The heuristic is
// `coeff × straight-line − credit`, and the straight line is at most the length of any path, so it is
// enough that the credit covers `Σ (coeff × length − cost)` over that path's edges. A walked edge's
// term is at most 0 by the definition of `coeff`; a crossing's is what a boat is for. Every ferry
// edge is in this sum, every term is non-negative, and the path's crossings are a subset of the
// city's, so the sum is at least the path's saving whatever chain of hops it rides. A multi-stop line
// is one edge per pier-to-pier hop, which is what a bound on the two largest shortcuts missed: three
// hops can save more than the best two.
//
// The wait is taken as zero and the crossing priced at the quickest sailing the timetable holds — a
// true lower bound over every departure time, and one that only makes the credit looser, so the
// estimate stays a lower bound at the price of expanding more nodes.
export function ferryCredit(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  if (!weights.allowFerries) {
    return 0;
  }
  const coeff = walkSecondsCoeff(graph, weights);
  const discount = ferryCrossingDiscount(weights);
  let credit = 0;
  for (const edge of graph.ferryEdges) {
    const quickest = graph.ferries?.covers(edge)
      ? graph.ferries.minRideSeconds(edge)
      : graph.edgeDurationSeconds[edge];
    credit += Math.max(0, coeff * graph.edgeLength[edge] - quickest * discount);
  }
  return credit;
}

// The least seconds ANY metre of the network can cost, whatever it is travelled by. The two credits
// above are sums over every ferry or transit edge in the city, and at a low transit penalty they
// swamp `coeff × straight-line` everywhere: the estimate goes to zero and A* settles for what
// Dijkstra would. So the caller takes the larger of the credited estimate and `floor × straight`,
// which is a lower bound on the trip in its own right — a path is at least as long as the straight
// line, and no metre of it is cheaper than this.
//
// A board edge that spans anything is in it too, at the boarding constant over its length: the wait
// on top of that is at least zero, so the constant alone bounds the edge below. Most board edges
// stand on their station and span nothing at all; the ones that do are the passage inside a transfer
// complex, up to 251 m of it in New York.
export function heuristicFloor(
  graph: RoutingGraph,
  weights: RouteWeights,
): number {
  let floor = walkSecondsCoeff(graph, weights);
  if (weights.allowFerries) {
    // Per ferry rather than from the baked figure: that one has the average wait fused into the
    // crossing, and a boat boarded with no wait costs less per metre than it.
    const discount = ferryCrossingDiscount(weights);
    for (const edge of graph.ferryEdges) {
      const length = graph.edgeLength[edge];
      const quickest = graph.ferries?.covers(edge)
        ? graph.ferries.minRideSeconds(edge)
        : graph.edgeDurationSeconds[edge];
      if (length > 0) {
        floor = Math.min(floor, (quickest * discount) / length);
      }
    }
  }
  if (weights.allowTransit && graph.transit !== null) {
    const multiplier = transitMultiplier(weights);
    floor = Math.min(
      floor,
      graph.minRideSecPerMetre * multiplier,
      graph.minAccessSecPerMetre,
    );
    for (const edge of graph.boardEdges) {
      const length = graph.edgeLength[edge];
      if (length > 0) {
        floor = Math.min(floor, (BOARDING_SECONDS * multiplier) / length);
      }
    }
  }
  return floor;
}
