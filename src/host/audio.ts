/**
 * The game's sound, all synthesized with WebAudio: no files.
 *
 * - An engine that follows speed and throttle: two detuned saws and a sine an octave
 *   below, through a low-pass that opens with the throttle. Quiet and round, so it can
 *   run for a whole session.
 * - Tyre squeal from `car.slip`: band-passed noise that fades in past a threshold.
 * - The ground under the car (`car.surface`), each a loop of the shared noise that rises with
 *   speed: a low wash in water (and a splash on driving in), a soft swish through the long
 *   grass (a low band of noise surging with a slow wobble), a low rattle on the rough ground
 *   (low noise chopped by a square wave that beats faster with speed). All of it stays low and soft.
 * - A short sound for each event: thud, thump, crunch, whoosh, clank, blip, flourish, buzz; a
 *   rock that throws the car is a dull knock and a scatter of grit.
 *
 * Browsers only start audio after the player does something, so nothing is built until
 * `unlock` (the first key press). Muting is a ramp on the master gain.
 */
import type { RaceEvent, RaceView } from "../sim/index.ts"

export interface Audio {
  /** On the first key press (any later call does nothing). */
  unlock(): void
  /** Each event, in order. `gapMs` is the gap to the best lap's split for a checkpoint, if there is one. */
  handle(event: RaceEvent, view: RaceView, gapMs: number | null): void
  /** Once per drawn frame. */
  update(view: RaceView): void
  setMuted(muted: boolean): void
  muted(): boolean
}

/** The loudest the whole mix gets. */
const masterVolume = 0.32

export const createAudio = (startMuted: boolean): Audio => {
  let isMuted = startMuted
  let context: AudioContext | null = null
  let master: GainNode | null = null
  let noise: AudioBuffer | null = null
  /** The parts of the engine and the squeal that `update` moves every frame. */
  let engine: {
    readonly saws: ReadonlyArray<OscillatorNode>
    readonly sub: OscillatorNode
    readonly filter: BiquadFilterNode
    readonly gain: GainNode
    readonly squealFilter: BiquadFilterNode
    readonly squealGain: GainNode
    readonly washFilter: BiquadFilterNode
    readonly washGain: GainNode
    readonly rustleGain: GainNode
    readonly rattleBeat: OscillatorNode
    readonly rattleGain: GainNode
  } | null = null
  /** The ground under the car last frame, and where the car was, to hear driving into water. */
  let lastSurface: RaceView["car"]["surface"] = "road"
  let lastX = 0
  let lastZ = 0

  const build = (): void => {
    const ctx = new AudioContext()
    context = ctx
    master = ctx.createGain()
    master.gain.value = isMuted ? 0 : masterVolume
    // A gentle compressor keeps a crash on top of the engine from clipping.
    const limiter = ctx.createDynamicsCompressor()
    limiter.threshold.value = -12
    limiter.ratio.value = 4
    master.connect(limiter).connect(ctx.destination)

    // Two seconds of white noise, shared by every noisy sound.
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const samples = noise.getChannelData(0)
    for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1

    const filter = ctx.createBiquadFilter()
    filter.type = "lowpass"
    filter.frequency.value = 400
    filter.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.value = 0
    filter.connect(gain).connect(master)
    const saws = [-8, 8].map((cents) => {
      const osc = ctx.createOscillator()
      osc.type = "sawtooth"
      osc.detune.value = cents
      osc.frequency.value = 50
      const level = ctx.createGain()
      level.gain.value = 0.5
      osc.connect(level).connect(filter)
      osc.start()
      return osc
    })
    const sub = ctx.createOscillator()
    sub.type = "sine"
    sub.frequency.value = 25
    const subLevel = ctx.createGain()
    subLevel.gain.value = 0.7
    sub.connect(subLevel).connect(gain)
    sub.start()

    const squealSource = ctx.createBufferSource()
    squealSource.buffer = noise
    squealSource.loop = true
    const squealFilter = ctx.createBiquadFilter()
    squealFilter.type = "bandpass"
    squealFilter.frequency.value = 1300
    squealFilter.Q.value = 9
    const squealGain = ctx.createGain()
    squealGain.gain.value = 0
    squealSource.connect(squealFilter).connect(squealGain).connect(master)
    squealSource.start()

    /** A looping noise source from a different point in the buffer, for each ground loop. */
    const loop = (offset: number): AudioBufferSourceNode => {
      const source = ctx.createBufferSource()
      source.buffer = noise
      source.loop = true
      source.start(0, offset)
      return source
    }
    // Water: low, rounded noise.
    const washFilter = ctx.createBiquadFilter()
    washFilter.type = "lowpass"
    washFilter.frequency.value = 500
    washFilter.Q.value = 0.7
    const washGain = ctx.createGain()
    washGain.gain.value = 0
    loop(0.3).connect(washFilter).connect(washGain).connect(master)
    // Grass: a low, soft band of noise, surging with a slow sine, as long blades swish past.
    const rustleFilter = ctx.createBiquadFilter()
    rustleFilter.type = "bandpass"
    rustleFilter.frequency.value = 620
    rustleFilter.Q.value = 0.7
    const rustleFlutter = ctx.createGain()
    rustleFlutter.gain.value = 0.6
    const flutter = ctx.createOscillator()
    flutter.frequency.value = 3.2
    const flutterDepth = ctx.createGain()
    flutterDepth.gain.value = 0.4
    flutter.connect(flutterDepth).connect(rustleFlutter.gain)
    flutter.start()
    const rustleGain = ctx.createGain()
    rustleGain.gain.value = 0
    loop(0.9).connect(rustleFilter).connect(rustleFlutter).connect(rustleGain).connect(master)
    // Stones: low noise chopped by a square wave, so it knocks rather than hisses.
    const rattleFilter = ctx.createBiquadFilter()
    rattleFilter.type = "lowpass"
    rattleFilter.frequency.value = 280
    rattleFilter.Q.value = 1.4
    const rattleChop = ctx.createGain()
    rattleChop.gain.value = 0.5
    const rattleBeat = ctx.createOscillator()
    rattleBeat.type = "square"
    rattleBeat.frequency.value = 10
    const beatDepth = ctx.createGain()
    beatDepth.gain.value = 0.5
    rattleBeat.connect(beatDepth).connect(rattleChop.gain)
    rattleBeat.start()
    const rattleGain = ctx.createGain()
    rattleGain.gain.value = 0
    loop(1.4).connect(rattleFilter).connect(rattleChop).connect(rattleGain).connect(master)

    engine = { saws, sub, filter, gain, squealFilter, squealGain, washFilter, washGain, rustleGain, rattleBeat, rattleGain }
  }

  /** A tone that glides from `from` to `to` Hz and fades out over `seconds`. */
  const tone = (type: OscillatorType, from: number, to: number, seconds: number, volume: number, delay = 0): void => {
    if (context === null || master === null) return
    const at = context.currentTime + delay
    const osc = context.createOscillator()
    osc.type = type
    osc.frequency.setValueAtTime(from, at)
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + seconds)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(volume, at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
    osc.connect(gain).connect(master)
    osc.start(at)
    osc.stop(at + seconds + 0.05)
  }

  /** A burst of filtered noise; the filter's frequency glides from `from` to `to`. */
  const hiss = (type: BiquadFilterType, from: number, to: number, q: number, seconds: number, volume: number, delay = 0, attack = 0.005): void => {
    if (context === null || master === null || noise === null) return
    const at = context.currentTime + delay
    const source = context.createBufferSource()
    source.buffer = noise
    // Start somewhere in the buffer, so repeated bursts do not sound identical.
    const offset = Math.random() * 1.5
    const filter = context.createBiquadFilter()
    filter.type = type
    filter.Q.value = q
    filter.frequency.setValueAtTime(from, at)
    filter.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + seconds)
    const gain = context.createGain()
    gain.gain.setValueAtTime(0.0001, at)
    gain.gain.exponentialRampToValueAtTime(volume, at + attack)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds)
    source.connect(filter).connect(gain).connect(master)
    source.start(at, offset)
    source.stop(at + seconds + 0.05)
  }

  const clamp01 = (value: number): number => Math.max(0, Math.min(1, value))

  return {
    unlock() {
      if (context === null) build()
      else if (context.state === "suspended") void context.resume()
    },
    handle(event, view, gapMs) {
      if (context === null) return
      switch (event.kind) {
        case "wall": {
          const hit = 0.25 + 0.75 * clamp01(event.impact / 12)
          tone("sine", 95, 42, 0.18, 0.5 * hit)
          hiss("lowpass", 500, 120, 0.7, 0.14, 0.35 * hit)
          break
        }
        case "land": {
          const hit = 0.3 + 0.7 * clamp01(event.impact / 10)
          tone("sine", 75, 38, 0.24, 0.6 * hit)
          hiss("lowpass", 320, 90, 0.7, 0.18, 0.3 * hit)
          break
        }
        case "prop":
        case "knock": {
          // A prop the car hit, or (quieter) a prop hitting something else.
          const hit = (event.kind === "knock" ? 0.45 : 1) * (0.35 + 0.65 * clamp01(event.impact / 14))
          if (event.prop === "crate") {
            tone("triangle", 170, 80, 0.12, 0.26 * hit)
            hiss("bandpass", 900, 420, 1.2, 0.14, 0.4 * hit)
          } else if (event.prop === "barrel") {
            tone("square", 210, 150, 0.16, 0.1 * hit)
            tone("triangle", 96, 70, 0.22, 0.24 * hit)
          } else if (event.prop === "cone") {
            hiss("bandpass", 1500, 900, 2, 0.05, 0.3 * hit)
          } else {
            tone("sine", 120, 62, 0.28, 0.5 * hit)
            tone("sine", 240, 150, 0.12, 0.14 * hit)
          }
          break
        }
        case "bollard": {
          const hit = 0.4 + 0.6 * clamp01(event.impact / 12)
          tone("sine", 92, 48, 0.2, 0.55 * hit)
          hiss("lowpass", 700, 200, 0.8, 0.12, 0.35 * hit)
          break
        }
        case "bump": {
          // A tyre striking a rock: a dull, low knock, then grit pattering down.
          const hit = 0.35 + 0.65 * clamp01((event.speed - 6) / 18)
          tone("sine", 68, 34, 0.28, 0.55 * hit)
          hiss("lowpass", 420, 120, 1, 0.2, 0.42 * hit)
          hiss("bandpass", 520, 300, 1.2, 0.28, 0.1 * hit, 0.06)
          break
        }
        case "door": {
          const hit = 0.4 + 0.6 * clamp01(event.impact / 12)
          tone("triangle", 150, 110, 0.18, 0.3 * hit)
          hiss("bandpass", 600, 300, 1.5, 0.2, 0.3 * hit)
          break
        }
        case "boost":
          hiss("bandpass", 350, 2400, 2.5, 0.45, 0.32, 0, 0.12)
          break
        case "drift":
          // The push at the end of a drift: the pad's rush, shorter and by how much was earned.
          hiss("bandpass", 300, 1800, 2.5, 0.3, 0.14 + 0.16 * event.charge, 0, 0.08)
          break
        case "checkpoint": {
          // Higher when ahead of the best split, lower when behind, neutral with no best.
          const pitch = gapMs === null ? 660 : gapMs <= 0 ? 880 : 440
          tone("sine", pitch, pitch, 0.11, 0.22)
          break
        }
        case "finish":
          ;[523.25, 659.25, 783.99, 1046.5].forEach((pitch, i) => tone("triangle", pitch, pitch, 0.35, 0.18, i * 0.075))
          break
        case "reset":
          if (event.reason === "off-track") {
            tone("sawtooth", 110, 98, 0.32, 0.08)
            tone("sawtooth", 116, 104, 0.32, 0.06)
          }
          break
        default:
          break
      }
    },
    update(view) {
      if (context === null || engine === null) return
      const now = context.currentTime
      const car = view.car
      const speed = Math.abs(car.speed)
      const pace = clamp01(speed / 30)
      const throttle = clamp01(car.throttle)
      // Pitch rises with speed and a little with the throttle; the filter opens with both.
      const pitch = 46 + pace * 70 + throttle * 8
      for (const saw of engine.saws) saw.frequency.setTargetAtTime(pitch, now, 0.06)
      engine.sub.frequency.setTargetAtTime(pitch / 2, now, 0.06)
      engine.filter.frequency.setTargetAtTime(220 + throttle * 520 + pace * 700, now, 0.08)
      engine.gain.gain.setTargetAtTime(0.07 + throttle * 0.06 + pace * 0.05, now, 0.1)
      // Squeal only on the ground and at some speed, past a little slip.
      const squeal = car.grounded ? clamp01((car.slip - 0.25) / 0.6) * clamp01(speed / 8) : 0
      engine.squealGain.gain.setTargetAtTime(squeal * 0.12, now, 0.05)
      engine.squealFilter.frequency.setTargetAtTime(1150 + squeal * 400, now, 0.1)

      // The ground: each loop rises with speed while the car is on it, and fades when it leaves.
      const moving = clamp01(speed / 4)
      const surface = car.grounded ? car.surface : "road"
      engine.washGain.gain.setTargetAtTime(surface === "water" ? 0.05 + 0.2 * pace * moving : 0, now, surface === "water" ? 0.05 : 0.25)
      engine.washFilter.frequency.setTargetAtTime(380 + pace * 520, now, 0.1)
      engine.rustleGain.gain.setTargetAtTime(surface === "grass" ? 0.11 * moving * (0.4 + pace) : 0, now, 0.12)
      engine.rattleGain.gain.setTargetAtTime(surface === "stones" ? 0.22 * moving * (0.5 + pace) : 0, now, 0.08)
      engine.rattleBeat.frequency.setTargetAtTime(7 + pace * 16, now, 0.1)
      // Driving into the water (not landing there from a jump in place): a splash and a low plop.
      const jumped = Math.hypot(car.x - lastX, car.z - lastZ) > Math.max(4, speed * 0.3 + 1)
      if (surface === "water" && lastSurface !== "water" && !jumped) {
        const hit = 0.4 + 0.6 * clamp01(speed / 20)
        hiss("lowpass", 1300, 240, 0.8, 0.5, 0.42 * hit)
        tone("sine", 120, 52, 0.22, 0.32 * hit)
      }
      lastSurface = surface
      lastX = car.x
      lastZ = car.z
    },
    setMuted(muted) {
      isMuted = muted
      if (context === null || master === null) return
      master.gain.setTargetAtTime(muted ? 0 : masterVolume, context.currentTime, 0.05)
    },
    muted: () => isMuted
  }
}
