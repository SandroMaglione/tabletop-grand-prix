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
  hudDim: 0x9aa4bb,
  hudAccent: 0xf6d32d,
  /** Ahead of the best lap, and behind it. */
  hudGood: 0x4bdc8e,
  hudBad: 0xff6b78,
  bronze: 0xd08a55,
  silver: 0xc3cad3,
  gold: 0xf2c544
} as const
