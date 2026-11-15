/**
 * The renderer to ask Pixi for: WebGPU where the browser's GPU can run PixiJS 3D on it,
 * WebGL elsewhere. `?renderer=webgl` in the page's address asks for WebGL outright.
 *
 * Every shader bit and effect of the game carries its code twice (`gpu` in WGSL, `gl` in
 * GLSL), so the picture is the same on both. Pixi would not fall back by itself in two
 * cases this checks for: an adapter without the feature PixiJS 3D needs, and a GPU that
 * offers WebGPU and then loses the device at the first frame, which would leave the map
 * blank behind a working page.
 */
export type Backend = "webgpu" | "webgl"

export const chooseBackend = async (): Promise<Backend> => {
  if (new URLSearchParams(location.search).get("renderer") === "webgl") return "webgl"
  if (!("gpu" in navigator)) return "webgl"
  const adapter = await navigator.gpu.requestAdapter().catch(() => null)
  if (adapter === null || !adapter.features.has("indirect-first-instance")) return "webgl"
  return (await drawsFrame(adapter)) ? "webgpu" : "webgl"
}

/** Whether `adapter` can really draw a frame on a canvas: one cleared frame on a throwaway canvas. */
const drawsFrame = async (adapter: GPUAdapter): Promise<boolean> => {
  let device: GPUDevice | null = null
  try {
    device = await adapter.requestDevice()
    let lost = false
    void device.lost.then(() => {
      lost = true
    })
    const context = document.createElement("canvas").getContext("webgpu")
    if (context === null) return false
    context.configure({ device, format: navigator.gpu.getPreferredCanvasFormat(), alphaMode: "premultiplied" })
    const encoder = device.createCommandEncoder()
    encoder.beginRenderPass({ colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store" }] }).end()
    device.queue.submit([encoder.finish()])
    // A frame that never finishes is not taken as a failure: the check only rules out what fails outright.
    await Promise.race([device.queue.onSubmittedWorkDone(), new Promise((done) => setTimeout(done, 1000))])
    return !lost
  } catch {
    return false
  } finally {
    device?.destroy()
  }
}
