/**
 * Names the server refuses. Every word here is written plainly; `names.ts` folds it the same
 * way it folds a name (lowercase, no accents, look-alike digits as letters), so "f4ck",
 * "FÜCK" and "f.u.c.k" are all caught by "fuck". Repeated letters in a name are caught too
 * ("fuuuck"), but a doubled letter in a word here must be doubled in the name ("nigger" does
 * not catch "Niger").
 *
 * To extend it, add a word to the list it belongs in and run `pnpm test`:
 * `test/names.test.ts` holds names that must pass and names that must not.
 */

/**
 * Refused wherever they appear in the name, even inside other letters. Only words that no
 * innocent word contains belong here, unless that word is listed in `innocent` below.
 */
export const anywhere: ReadonlyArray<string> = [
  // English
  "fuck",
  "fvck",
  "phuck",
  "phuk",
  "shit",
  "cunt",
  "bitch",
  "whore",
  "slut",
  "asshole",
  "arsehole",
  "bastard",
  "bollocks",
  "wank",
  "twat",
  "cocksuck",
  "motherf",
  "dickhead",
  "jizz",
  "nigger",
  "nigga",
  "niggr",
  "faggot",
  "fagget",
  "retard",
  "tranny",
  "shemale",
  "wetback",
  "beaner",
  "raghead",
  "towelhead",
  "chingchong",
  "nazi",
  "hitler",
  "heilhit",
  "siegheil",
  "kkk",
  "porn",
  "pedo",
  "paedo",
  "molest",
  "incest",
  "vagina",
  "penis",
  "dildo",
  "blowjob",
  "handjob",
  "rimjob",
  "buttplug",
  "cumshot",
  // Italian
  "cazzo",
  "cazzi",
  "cazzat",
  "minchia",
  "minchion",
  "puttan",
  "troiett",
  "stronz",
  "coglion",
  "vaffancul",
  "fanculo",
  "merda",
  "frocio",
  "froci",
  "ricchion",
  "recchion",
  "mignott",
  "bocchin",
  "pompin",
  "porcodio",
  "porcamadonna",
  "diocane",
  "dioporco",
  "diobestia",
  "madonnaputtana",
  "negro",
  "terroni",
  "mongoloid",
  "handicappat",
  "inculat",
  "sborr",
  "sburr",
  "culatton",
  "leccaculo",
  "figlioditroia",
  "figliodiputtana"
]

/**
 * Refused only as a whole word of the name: the whole name, or one of its words when the name
 * has spaces, dashes, underscores, dots or capitals between them ("Big Dick", "BigDick"), with
 * any digits after it ("dick69"). Short words that hide inside innocent ones live here.
 */
export const whole: ReadonlyArray<string> = [
  // English
  "ass",
  "arse",
  "anus",
  "cock",
  "pussy",
  "dick",
  "cum",
  "tits",
  "titty",
  "boob",
  "boobs",
  "fag",
  "dyke",
  "homo",
  "spic",
  "chink",
  "gook",
  "kike",
  "coon",
  "paki",
  "jap",
  "rape",
  "rapist",
  "raper",
  "sex",
  "sexy",
  "nude",
  "nudes",
  "milf",
  "piss",
  "crap",
  "damn",
  "hoe",
  "thot",
  "incel",
  "nonce",
  "jihad",
  "fap",
  "wtf",
  "stfu",
  "gtfo",
  // Italian
  "culo",
  "culi",
  "fica",
  "figa",
  "troia",
  "troie",
  "zoccola",
  "pirla",
  "frocio",
  "finocchio",
  "ricchione",
  "terrone",
  "ritardato",
  "ritardata",
  "mongolo",
  "puttana"
]

/**
 * Innocent words that contain a word from `anywhere`. Each is taken out of the name before the
 * `anywhere` words are looked for, so "Scunthorpe" and "Montenegro" pass while "cunt" and
 * "negro" do not.
 */
export const innocent: ReadonlyArray<string> = [
  "scunthorpe",
  "shiitake",
  "shitake",
  "snigger",
  "swank",
  "nazion",
  "montenegr",
  "negroni",
  "penistone",
  "retardant",
  "pedometer",
  "pedone",
  "pedoni",
  "pedal",
  "pedro",
  "torpedo",
  "speedo"
]

/**
 * Names kept back: someone who holds one could pass for the game, its makers or the server. The
 * first list is refused anywhere in a name ("admin42", "the_official"), the second only as the
 * whole name.
 */
export const reservedAnywhere: ReadonlyArray<string> = ["admin", "moderator", "official", "typeonce", "pixijs", "cloudflare"]

export const reservedWhole: ReadonlyArray<string> = [
  "mod",
  "mods",
  "staff",
  "team",
  "support",
  "help",
  "system",
  "root",
  "server",
  "owner",
  "dev",
  "developer",
  "pixi",
  "ritmo",
  "tabletop",
  "tabletopgrandprix",
  "grandprix",
  "anonymous",
  "anon",
  "unknown",
  "guest",
  "player",
  "nobody",
  "someone",
  "you",
  "ghost",
  "rival",
  "null",
  "undefined",
  "nan",
  "test",
  "bot"
]
