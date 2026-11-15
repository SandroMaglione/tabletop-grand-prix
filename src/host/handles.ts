/**
 * Names nobody typed: what a player is called on the board until they pick a name of their
 * own, and what the name panel's `RANDOM` offers.
 *
 * A handle is three words that make a small sentence about an animal at the wheel: how it
 * is, what it is, and what it does. "Shy Otter Skids", "Bold Yak Brakes", "Lazy Sloth Naps".
 * The words are short on purpose, since the whole name must fit the longest name the board
 * takes (`nameMaxLength`); a draw that does not fit is drawn again. That leaves close to
 * two hundred thousand names, so two players are rarely given the same one, and when they
 * are the server says so and the page draws another (`online.ts`).
 *
 * Every handle must pass the server's name rules, which read a name with its spaces out, so
 * two harmless words can spell a refused one where they meet (a mole that stalls, a hyena
 * that zips). `test/names.test.ts` tries every handle: add a word and it says what it broke.
 */
import { nameMaxLength } from "../api/names.ts"

export const handleWords = {
  how: [
    "Agile", "Balmy", "Bold", "Bossy", "Brash", "Brave", "Brisk", "Bumpy", "Burly", "Calm", "Corny", "Cosy", "Coy", "Daft", "Dandy", "Deft",
    "Dizzy", "Dozy", "Dusty", "Eager", "Faint", "Fancy", "Fizzy", "Fuzzy", "Giddy", "Glum", "Goofy", "Grand", "Gusty", "Handy", "Hasty", "Hefty",
    "Icy", "Jazzy", "Jolly", "Jumpy", "Keen", "Lanky", "Late", "Lazy", "Leaky", "Lofty", "Loud", "Lucky", "Merry", "Messy", "Mild", "Moody",
    "Muddy", "Nifty", "Noisy", "Nutty", "Odd", "Peppy", "Perky", "Pesky", "Plump", "Proud", "Quick", "Quiet", "Rapid", "Rowdy", "Royal", "Rusty",
    "Salty", "Sharp", "Shiny", "Shy", "Silly", "Slick", "Sly", "Smug", "Soggy", "Spicy", "Stout", "Sunny", "Swift", "Tall", "Tidy", "Tiny",
    "Vivid", "Warm", "Wary", "Wild", "Windy", "Witty", "Wonky", "Wry", "Young", "Zesty", "Zippy"
  ],
  who: [
    "Alpaca", "Ant", "Badger", "Bat", "Bear", "Beetle", "Bison", "Bobcat", "Camel", "Cod", "Corgi", "Crab", "Crow", "Deer", "Dingo", "Donkey",
    "Duck", "Eagle", "Eel", "Emu", "Falcon", "Ferret", "Finch", "Fox", "Frog", "Gecko", "Gibbon", "Goose", "Gopher", "Gull", "Hare", "Hen",
    "Heron", "Hippo", "Hornet", "Hyena", "Ibex", "Ibis", "Iguana", "Jackal", "Kiwi", "Koala", "Lark", "Lemur", "Llama", "Lynx", "Magpie", "Marmot",
    "Mink", "Moose", "Moth", "Mouse", "Newt", "Ocelot", "Orca", "Osprey", "Otter", "Owl", "Oyster", "Panda", "Parrot", "Pigeon", "Pony",
    "Possum", "Puffin", "Pug", "Puma", "Quail", "Rabbit", "Ram", "Raven", "Robin", "Salmon", "Seal", "Shrew", "Shrimp", "Skunk", "Sloth", "Snail",
    "Squid", "Stoat", "Swan", "Tapir", "Tiger", "Toad", "Trout", "Turtle", "Viper", "Walrus", "Weasel", "Whale", "Wolf", "Wombat", "Wren", "Yak",
    "Zebra"
  ],
  does: [
    "Bolts", "Boosts", "Brakes", "Bumps", "Clips", "Coasts", "Darts", "Dashes", "Dodges", "Drafts", "Drifts", "Ducks", "Flies", "Glides", "Honks", "Hops",
    "Idles", "Jumps", "Lands", "Laps", "Leaps", "Lifts", "Lunges", "Merges", "Naps", "Nudges", "Parks", "Purrs", "Races", "Revs", "Roars", "Rolls",
    "Rushes", "Scoots", "Shifts", "Shoves", "Skids", "Slides", "Slips", "Slows", "Speeds", "Spins", "Stalls", "Steers", "Trots", "Turns", "Vaults", "Wades",
    "Waits", "Weaves", "Whirs", "Wins", "Yields", "Zooms"
  ]
} as const

const pick = (words: ReadonlyArray<string>, random: () => number): string => words[Math.min(words.length - 1, Math.floor(random() * words.length))] ?? ""

/** One handle. `random` gives numbers from 0 up to 1, like `Math.random`. */
export const makeHandle = (random: () => number = Math.random): string => {
  // About half the draws fit, so this ends at once; the last line is for a `random` that never varies.
  for (let tries = 0; tries < 64; tries++) {
    const handle = `${pick(handleWords.how, random)} ${pick(handleWords.who, random)} ${pick(handleWords.does, random)}`
    if (handle.length <= nameMaxLength) return handle
  }
  return "Shy Otter Skids"
}
