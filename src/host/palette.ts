/**
 * The game's colours, in one place, as sRGB hex.
 *
 * The look is a solid scale model on a pale table: a thick slab of terrain with the road
 * milled into it, ramps as solid wedges, real-world materials, soft daylight. Calm and
 * clean like Inkline Town's page, but lit and solid instead of drawn in line.
 */
export const palette = {
  /** The page and the table the model stands on. */
  backdrop: 0xe9e6df,
  table: 0xdedad1,
  /** Terrain: the top is grass, every cut face (channel sides, slab edges, embankments) is packed earth. */
  grass: 0x8ea676,
  grassDark: 0x7c9567,
  /** The lip along the top of a channel's wall. */
  grassLip: 0xb3c093,
  earth: 0xb39770,
  earthDark: 0x8f7655,
  /** Road. */
  asphalt: 0x4b4d52,
  asphaltLight: 0x5d6066,
  line: 0xf2efe6,
  kerbRed: 0xd2473a,
  kerbWhite: 0xf2efe6,
  /** Built things: retaining walls, bridge decks, pillars, ramp faces. */
  concrete: 0xc9c5ba,
  concreteDark: 0xa39f94,
  /** The car and its ghost. */
  car: 0xe4572e,
  carStripe: 0xf7f3ea,
  /** The car's paint for a place on the board (`standing.ts`): the podium, and the rest of the top ten. */
  paintGold: 0xf6b422,
  paintSilver: 0xc4cedb,
  paintBronze: 0xec8a3f,
  paintPearl: 0x3657e6,
  /** Below the top ten: flat and unpolished. */
  paintDull: 0x8a8f97,
  /** The podium cars' stripe: glossy and dark, so the metal round it reads brighter. */
  podiumStripe: 0x15171c,
  glass: 0x2a3440,
  tyre: 0x232427,
  ghost: 0x6fa8dc,
  /** Things to hit or use. */
  crate: 0xc99a5b,
  crateDark: 0x9b723d,
  boost: 0x3ec6e0,
  gateYellow: 0xf2c230,
  gateBlack: 0x2b2b2e,
  cone: 0xf07f2e,
  /** A cone's reflective bands and its moulded foot. */
  coneBand: 0xf4f1e8,
  coneFoot: 0xdb6a2a,
  /** Steel drums: painted body, the rolled hoops and the lid. */
  barrel: 0x3f72a3,
  barrelHoop: 0x366592,
  barrelLid: 0x4f7eae,
  /** The heavy ball's gores and its band. */
  ballA: 0xd2473a,
  ballB: 0xf2efe6,
  ballBand: 0x2e2f33,
  /** Bollards: a concrete post with a hazard band near the top. */
  bollard: 0xb4afa3,
  hazardYellow: 0xf2c230,
  hazardBlack: 0x2b2b2e,
  /** Swing doors: striped boards on a steel hinge post. */
  doorRed: 0xd2473a,
  doorWhite: 0xf4f1e8,
  hinge: 0x6b7078,
  /** The short light thrown by a hit, and the brake lights' glow on the road. */
  hitLight: 0xffd29a,
  brakeGlow: 0xff2a1a,
  /** Scenery. */
  tree: 0x4f7a55,
  /** The pond: water at the shore and in the middle, and the wet sand around it. */
  water: 0x6f9c9a,
  waterDeep: 0x2f5f6a,
  shore: 0xb8ab84,
  reed: 0xa9ad6c,
  reedDark: 0x55704a,
  /** Wind turbines: white towers and blades, a red light on the nacelle. */
  turbine: 0xeeece6,
  turbineLight: 0xff3a2a,
  treeDark: 0x3f6647,
  trunk: 0x7a5a3c,
  /** Grandstand seats and its roof. */
  seat: 0x5f7f9c,
  roof: 0xe6e2d8,
  /** Lights and effects on the moving things. */
  brakeLight: 0xff3324,
  headLight: 0xfff3d2,
  boostPlate: 0x1d4e5c,
  flame: 0xa8f4ff,
  smoke: 0xf2efe9,
  dust: 0xc4ab82,
  spark: 0xffc457,
  /** A drift: the sparks and the HUD's bar while a slide earns its push, and once it has earned all of it. */
  driftCharge: 0x6fb6ff,
  driftFull: 0xff9a3d,
  skid: 0x1b1c1f,
  lampRed: 0xff3a2a,
  lampAmber: 0xffae22,
  lampGreen: 0x52d97c,
  /** Ink for outlines and the HUD's text. */
  ink: 0x26282c,
  /** The pale ring of the marker over the car. */
  hudPanel: 0xfbfaf6,
  /** HUD: dark panels the map shows through, white text, one yellow accent. */
  hudBack: 0x141a2e,
  hudHead: 0x0b0f1f,
  hudText: 0xffffff,
  hudDim: 0xb9c1d3,
  hudAccent: 0xf6d32d,
  /** Ahead of the best lap, and behind it. */
  hudGood: 0x4bdc8e,
  hudBad: 0xff6b78,
  /** The same two as the colour of a whole band behind white text. */
  hudGoodDeep: 0x1f9a56,
  hudBadDeep: 0xd43a45,
  bronze: 0xd08a55,
  silver: 0xc3cad3,
  gold: 0xf2c544,
  /** The meadow: dark turf and soil under the clumps, the shadow at its edge, blades from the root to the sun-bleached tip, seed heads, clippings. */
  turf: 0x3f5a2b,
  turfDark: 0x2f4521,
  turfSoil: 0x4a3f2e,
  grassShadow: 0x1f2a17,
  bladeRoot: 0x223a18,
  bladeMid: 0x527f33,
  bladeTip: 0xa8bd5c,
  seedHead: 0xd8cb93,
  clipping: 0x86a24f,
  /** The ford: the wet bed under the water, the water in the shallows and the middle, spray. */
  fordBed: 0x2b2a27,
  fordShallow: 0x84a5a3,
  fordDeep: 0x44666b,
  spray: 0xe9f1f0,
  /** A tyre's wet track on the road after the ford: the film of water it leaves, which shows the sky. */
  wetTrack: 0x9fc0c4,
  /** The stony ground: packed dirt from dark to pale, gravel, stones half sunk in it, the rocks to bounce over (pale weathered tops, lichen), dust. */
  dirt: 0x7d6347,
  dirtDark: 0x4f3f2e,
  dirtLight: 0xa08a68,
  gravel: 0x8e877b,
  pebble: 0xb3ada2,
  rock: 0x9a958b,
  rockDark: 0x6c675f,
  rockLight: 0xc9c3b6,
  lichen: 0xb5b26a,
  stoneDust: 0xcbb999
} as const
