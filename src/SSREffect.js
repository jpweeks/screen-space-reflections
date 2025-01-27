﻿import { Effect, Selection } from "postprocessing"
import { Quaternion, Uniform, Vector2, Vector3 } from "three"
import { TemporalResolvePass } from "./temporal-resolve/pass/TemporalResolvePass.js"
import bilateralBlur from "./material/shader/bilateralBlur.frag"
import finalSSRShader from "./material/shader/finalSSRShader.frag"
import customTRComposeShader from "./material/shader/customTRComposeShader.frag"
import customBasicComposeShader from "./material/shader/customBasicComposeShader.frag"
import helperFunctions from "./material/shader/helperFunctions.frag"
import temporalResolve from "./temporal-resolve/shader/temporalResolve.frag"
import { ReflectionsPass } from "./pass/ReflectionsPass.js"

const finalFragmentShader = finalSSRShader
	.replace("#include <helperFunctions>", helperFunctions)
	.replace("#include <bilateralBlur>", bilateralBlur)

export const defaultSSROptions = {
	temporalResolve: true,
	temporalResolveMix: 0.9,
	temporalResolveCorrectionMix: 1,
	maxSamples: 256,
	resolutionScale: 1,
	width: typeof window !== "undefined" ? window.innerWidth : 2000,
	height: typeof window !== "undefined" ? window.innerHeight : 1000,
	ENABLE_BLUR: false,
	blurMix: 0.5,
	blurKernelSize: 8,
	blurSharpness: 0.5,
	rayStep: 0.1,
	intensity: 1,
	maxRoughness: 0.1,
	ENABLE_JITTERING: false,
	jitter: 0.1,
	jitterSpread: 0.1,
	jitterRough: 0,
	roughnessFadeOut: 1,
	rayFadeOut: 0,
	MAX_STEPS: 20,
	NUM_BINARY_SEARCH_STEPS: 5,
	maxDepthDifference: 10,
	maxDepth: 1,
	thickness: 10,
	ior: 1.45,
	STRETCH_MISSED_RAYS: true,
	USE_MRT: true,
	USE_NORMALMAP: true,
	USE_ROUGHNESSMAP: true
}

// all the properties for which we don't have to resample
const noResetSamplesProperties = ["ENABLE_BLUR", "blurSharpness", "blurKernelSize", "blurMix"]

export class SSREffect extends Effect {
	samples = 0
	selection = new Selection()
	#lastSize
	#lastCameraTransform = {
		position: new Vector3(),
		quaternion: new Quaternion()
	}

	constructor(scene, camera, options = defaultSSROptions) {
		super("SSREffect", finalFragmentShader, {
			type: "FinalSSRMaterial",
			uniforms: new Map([
				["inputTexture", new Uniform(null)],
				["reflectionsTexture", new Uniform(null)],
				["depthTexture", new Uniform(null)],
				["samples", new Uniform(0)],
				["blurMix", new Uniform(0)],
				["g_Sharpness", new Uniform(0)],
				["g_InvResolutionDirection", new Uniform(new Vector2())],
				["kernelRadius", new Uniform(0)]
			]),
			defines: new Map([["RENDER_MODE", "0"]])
		})

		this._scene = scene
		this._camera = camera

		options = { ...defaultSSROptions, ...options }

		// set up passes

		// temporal resolve pass
		this.temporalResolvePass = new TemporalResolvePass(scene, camera, "", options)
		this.temporalResolvePass.fullscreenMaterial.uniforms.samples = new Uniform(0)
		this.temporalResolvePass.fullscreenMaterial.uniforms.maxSamples = new Uniform(0)
		this.temporalResolvePass.fullscreenMaterial.defines.EULER = 2.718281828459045
		this.temporalResolvePass.fullscreenMaterial.defines.FLOAT_EPSILON = 0.00001

		this.uniforms.get("reflectionsTexture").value = this.temporalResolvePass.renderTarget.texture

		// reflections pass
		this.reflectionsPass = new ReflectionsPass(this, options)
		this.temporalResolvePass.fullscreenMaterial.uniforms.inputTexture.value = this.reflectionsPass.renderTarget.texture
		this.temporalResolvePass.fullscreenMaterial.uniforms.depthTexture.value = this.reflectionsPass.depthTexture

		this.#lastSize = { width: options.width, height: options.height, resolutionScale: options.resolutionScale }
		this.#lastCameraTransform.position.copy(camera.position)
		this.#lastCameraTransform.quaternion.copy(camera.quaternion)

		this.setSize(options.width, options.height)

		this.#makeOptionsReactive(options)
	}

	#makeOptionsReactive(options) {
		// this can't be toggled during run-time
		if (options.ENABLE_BLUR) {
			this.uniforms.get("depthTexture").value = this.reflectionsPass.depthTexture
			this.defines.set("ENABLE_BLUR", "")
			this.reflectionsPass.fullscreenMaterial.defines.ENABLE_BLUR = ""
		}

		const dpr = window.devicePixelRatio
		let needsUpdate = false

		const reflectionPassFullscreenMaterialUniforms = this.reflectionsPass.fullscreenMaterial.uniforms
		const reflectionPassFullscreenMaterialUniformsKeys = Object.keys(reflectionPassFullscreenMaterialUniforms)

		for (const key of Object.keys(options)) {
			Object.defineProperty(this, key, {
				get() {
					return options[key]
				},
				set(value) {
					if (options[key] === value && needsUpdate) return

					options[key] = value

					if (!noResetSamplesProperties.includes(key)) this.samples = 1

					switch (key) {
						case "resolutionScale":
							this.setSize(options.width, options.height)
							break

						case "width":
							if (value === undefined) return
							this.setSize(value * dpr, options.height)
							this.uniforms.get("g_InvResolutionDirection").value.set(1 / (value * dpr), 1 / options.height)
							break

						case "height":
							if (value === undefined) return
							this.setSize(options.width, value * dpr)
							this.uniforms.get("g_InvResolutionDirection").value.set(1 / options.width, 1 / (value * dpr))
							break

						case "maxSamples":
							this.temporalResolvePass.fullscreenMaterial.uniforms.maxSamples.value = this.maxSamples
							break

						case "blurMix":
							this.uniforms.get("blurMix").value = value
							break

						case "blurSharpness":
							this.uniforms.get("g_Sharpness").value = value
							break

						case "blurKernelSize":
							this.uniforms.get("kernelRadius").value = value
							break

						// defines
						case "MAX_STEPS":
							this.reflectionsPass.fullscreenMaterial.defines.MAX_STEPS = parseInt(value)
							this.reflectionsPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "NUM_BINARY_SEARCH_STEPS":
							this.reflectionsPass.fullscreenMaterial.defines.NUM_BINARY_SEARCH_STEPS = parseInt(value)
							this.reflectionsPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "ENABLE_JITTERING":
							if (value) {
								this.reflectionsPass.fullscreenMaterial.defines.ENABLE_JITTERING = ""
							} else {
								delete this.reflectionsPass.fullscreenMaterial.defines.ENABLE_JITTERING
							}

							this.reflectionsPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "STRETCH_MISSED_RAYS":
							if (value) {
								this.reflectionsPass.fullscreenMaterial.defines.STRETCH_MISSED_RAYS = ""
							} else {
								delete this.reflectionsPass.fullscreenMaterial.defines.STRETCH_MISSED_RAYS
							}

							this.reflectionsPass.fullscreenMaterial.needsUpdate = needsUpdate
							break

						case "USE_NORMALMAP":
						case "USE_ROUGHNESSMAP":
							break

						case "temporalResolve":
							const composeShader = value ? customTRComposeShader : customBasicComposeShader
							let fragmentShader = temporalResolve

							// if we are not using temporal reprojection, then cut out the part that's doing the reprojection
							if (!value) {
								const removePart = fragmentShader.slice(
									fragmentShader.indexOf("// REPROJECT_START"),
									fragmentShader.indexOf("// REPROJECT_END") + "// REPROJECT_END".length
								)
								fragmentShader = temporalResolve.replace(removePart, "")
							}

							fragmentShader = fragmentShader.replace("#include <custom_compose_shader>", composeShader)

							fragmentShader =
								/* glsl */ `
							uniform float samples;
							uniform float maxSamples;
							uniform float temporalResolveMix;
							` + fragmentShader

							this.temporalResolvePass.fullscreenMaterial.fragmentShader = fragmentShader
							this.temporalResolvePass.fullscreenMaterial.needsUpdate = true
							break

						case "temporalResolveMix":
							this.temporalResolvePass.fullscreenMaterial.uniforms.temporalResolveMix.value = value
							break

						case "temporalResolveCorrectionMix":
							this.temporalResolvePass.fullscreenMaterial.uniforms.temporalResolveCorrectionMix.value = value
							break

						// must be a uniform
						default:
							if (reflectionPassFullscreenMaterialUniformsKeys.includes(key)) {
								reflectionPassFullscreenMaterialUniforms[key].value = value
							}
					}
				}
			})

			// apply all uniforms and defines
			this[key] = options[key]
		}

		needsUpdate = true
	}

	setSize(width, height) {
		if (
			width === this.#lastSize.width &&
			height === this.#lastSize.height &&
			this.resolutionScale === this.#lastSize.resolutionScale
		)
			return

		this.temporalResolvePass.setSize(width, height)
		this.reflectionsPass.setSize(width, height)

		this.#lastSize = { width, height, resolutionScale: this.resolutionScale }
	}

	checkNeedsResample() {
		const moveDist = this.#lastCameraTransform.position.distanceToSquared(this._camera.position)
		const rotateDist = 8 * (1 - this.#lastCameraTransform.quaternion.dot(this._camera.quaternion))

		if (moveDist > 0.000001 || rotateDist > 0.000001) {
			this.samples = 1

			this.#lastCameraTransform.position.copy(this._camera.position)
			this.#lastCameraTransform.quaternion.copy(this._camera.quaternion)
		}
	}

	dispose() {
		super.dispose()

		this.reflectionsPass.dispose()
		this.temporalResolvePass.dispose()
	}

	update(renderer, inputBuffer) {
		this.samples++
		this.checkNeedsResample()

		// update uniforms
		this.uniforms.get("samples").value = this.samples

		// render reflections of current frame
		this.reflectionsPass.render(renderer, inputBuffer)

		// compose reflection of last and current frame into one reflection
		this.temporalResolvePass.fullscreenMaterial.uniforms.samples.value = this.samples
		this.temporalResolvePass.render(renderer)
	}
}
