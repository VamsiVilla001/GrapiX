# The effects programme: all 306 of EffectCraft's effects on the engine (row 3.25)
User direction (19 and 20 November 2026): every effect renders on the backend, and the Editor viewport shows them. The engine renders every effect; the viewport shows the engine's frame (11.69 and the viewport-source rules).
**Done: 46 of 306. Remaining: 260.** Every remaining effect is listed here once, in the wave that its kernel needs. A wave is built in batches of about four effects, each with a contract, a CPU reference, a WGSL kernel, a hardware GPU parity test, independently computed known pixels and a mutation run (the method of `docs/evidence/3.25`).
Where an effect is not a pixel kernel (waves 8 and 9) it is not silently skipped and not drawn wrongly: it is listed by name and decided with the user.

## Wave 1: one pixel in, one pixel out (colour, keying, channel arithmetic, simple stylize): 36

*Needs:* the batch method of 3.25 as it stands; the cheapest class and the broadcast core.

channel.blend, channel.calculations, channel.cccomposite, channel.combiner, channel.compoundarithmetic, channel.minimax, channel.setchannels, channel.setmatte, channel.solidcomposite, color.autocolor, color.autocontrast, color.autolevels, color.cckernel, color.changetocolor, color.colorama, color.colorlink, color.colorstabilizer, color.equalize, color.levelsic, color.lumetri, color.ociocdl, color.ociocolorspace, color.ociodisplay, color.ociolook, color.psarbitrarymap, color.shadowhighlight, key.advancedspill, key.ccsimplewireremoval, key.colorkey, key.differencematte, key.innerouter, key.keycleaner, key.luma, key.screen, stylize.ccvignette, stylize.coloremboss

## Wave 2: neighbourhood passes (blurs, sharpen, median, grain and noise, edges, mosaic, mattes): 51

*Needs:* the engine's spatial pass plan (`effect_chain.rs`, kernels 8 to 18) grows reusable passes: separable convolution, a median/rank pass, a noise source, a distance-field pass for mattes.

blur.bilateral, blur.cameralens, blur.camerashakedeblur, blur.cccross, blur.ccradial, blur.ccradialfast, blur.ccvector, blur.channel, blur.compound, blur.radial, blur.reduceflicker, blur.sharpen, blur.smart, blur.unsharp, keying.keylight, matte.mattechoker, matte.refinehard, matte.refinesoft, matte.rotobrush, matte.simplechoker, noise.addgrain, noise.curlnoise, noise.dustscratches, noise.fractal, noise.matchgrain, noise.median, noise.medianlegacy, noise.noise, noise.noisealpha, noise.noisehls, noise.noisehlsauto, noise.removegrain, noise.turbulent, stylize.brushstrokes, stylize.cartoon, stylize.ccblockload, stylize.ccburnfilm, stylize.ccglass, stylize.cchextile, stylize.cckaleida, stylize.ccmrsmoothie, stylize.ccplastic, stylize.ccrepetile, stylize.emboss, stylize.findedges, stylize.mosaic, stylize.motiontile, stylize.roughenedges, stylize.scatter, stylize.strobe, stylize.texturize

## Wave 3: coordinate warps (distort, perspective): 45

*Needs:* one resample pass with a per-effect coordinate function, over the existing coordinate passes; bevels and shadows ride the matte passes of wave 2.

distort.bezierwarp, distort.bulge, distort.ccbender, distort.ccbendit, distort.ccblobbylize, distort.ccflomotion, distort.ccgriddler, distort.cclens, distort.ccpageturn, distort.ccpowerpin, distort.ccripplepulse, distort.ccslant, distort.ccsmear, distort.ccsplit, distort.ccsplit2, distort.cctiler, distort.cornerpin, distort.displacementmap, distort.liquify, distort.magnify, distort.meshwarp, distort.mirror, distort.offset, distort.opticscompensation, distort.polar, distort.puppet, distort.reshape, distort.ripple, distort.smear, distort.spherize, distort.transform, distort.turbulentdisplace, distort.twirl, distort.twirllegacy, distort.upscale, distort.warp, distort.wavewarp, perspective.3dglasses, perspective.bevelalpha, perspective.beveledges, perspective.cccylinder, perspective.ccenvironment, perspective.ccsphere, perspective.ccspotlight, perspective.radialshadow

## Wave 4: generators and text (layers that make pixels from nothing): 27

*Needs:* procedural kernels with no source texture; text generators (numbers, timecode) read the engine clock.

generate.advancedlightning, generate.audiospectrum, generate.audiowaveform, generate.beam, generate.ccgluegun, generate.cclightburst, generate.cclightrays, generate.cclightsweep, generate.ccthreads, generate.cellpattern, generate.checkerboard, generate.circle, generate.ellipse, generate.eyedropperfill, generate.fourcolor, generate.fractal, generate.grid, generate.lensflare, generate.paintbucket, generate.radiowaves, generate.scribble, generate.stroke, generate.vegas, generate.writeon, paint.paint, text.numbers, text.timecode

## Wave 5: transitions (need a second layer): 14

*Needs:* a two-input pass: the effect layer and a named transition layer (the Layer parameter kind of EffectCraft).

transition.blockdissolve, transition.cardwipe, transition.ccglasswipe, transition.ccgridwipe, transition.ccimagewipe, transition.ccjaws, transition.cclightwipe, transition.cclinesweep, transition.ccradialscalewipe, transition.ccscalewipe, transition.cctwister, transition.ccwarpomatic, transition.gradientwipe, transition.venetian

## Wave 6: time and 360 (need frames other than this one): 20

*Needs:* a bounded frame history per layer; VR/360 effects need the equirectangular resample of wave 3.

time.ccforcemotionblur, time.ccwidetime, time.echo, time.pixelmotionblur, time.posterizetime, time.timedifference, time.timedisplacement, time.timewarp, vr.blur, vr.chromaticaberrations, vr.colorgradients, vr.converter, vr.denoise, vr.digitalglitch, vr.fractalnoise, vr.glow, vr.planetosphere, vr.rotatesphere, vr.sharpen, vr.spheretoplane

## Wave 7: simulations and particles: 18

*Needs:* a stateful GPU simulation per effect; deterministic from the object id and the frame (the two-renders-identical rule).

sim.carddance, sim.caustics, sim.ccballaction, sim.ccbubbles, sim.ccdrizzle, sim.cchair, sim.ccmrmercury, sim.ccparticlesystems2, sim.ccparticleworld, sim.ccpixelpolly, sim.ccrainfall, sim.ccscatterize, sim.ccsnowfall, sim.ccstarburst, sim.foam, sim.particleplayground, sim.shatter, sim.waveworld

## Wave 8: analysis, 3D and tracking: 21

*Needs:* needs AOV/depth inputs and analysis passes (camera tracker, face tracking, warp stabiliser, Cryptomatte); not a pixel kernel.

3d.channelextract, 3d.cryptomatte, 3d.depthmatte, 3d.depthoffield, 3d.extractor, 3d.fog3d, 3d.identifier, 3d.idmatte, color.ociofile, distort.rollingshutterrepair, distort.warpstabilizer, perspective.cameratracker, utility.applylut, utility.ccoverbrights, utility.cineon, utility.colorprofileconverter, utility.facemeasurements, utility.facetrackpoints, utility.growbounds, utility.hdrcompander, utility.hdrcompression

## Wave 9: not image effects as such: 28

*Needs:* audio effects (13) run on audio, not pixels; control effects (9) are parameter holders; obsolete effects (6) are superseded; each is decided by name with the user, not skipped.

audio.backwards, audio.basstreble, audio.compressor, audio.delay, audio.distortion, audio.flangechorus, audio.gate, audio.highlowpass, audio.modulator, audio.parametriceq, audio.reverb, audio.stereomixer, audio.tone, control.angle, control.checkbox, control.color, control.dropdown, control.layer, control.point, control.point3d, control.slider, control.stereo3d, obsolete.basic3d, obsolete.basictext, obsolete.gaussianlegacy, obsolete.lightning, obsolete.mochashape, obsolete.pathtext

## Done so far

blur.directional, blur.fastbox, blur.gaussian, channel.invert, channel.shiftchannels, color.blackwhite, color.brightnesscontrast, color.broadcast, color.cccoloroffset, color.cctoner, color.changecolor, color.channelmixer, color.colorbalance, color.colorbalancehls, color.curves, color.exposure, color.gammapedestalgain, color.huesaturation, color.leavecolor, color.levels, color.photofilter, color.tint, color.tritone, color.vibrance, color.videolimiter, color.cccolorneutralizer, key.extract, key.spill, key.unmult, key.linearcolor, key.colorrange, channel.arithmetic, key.colordifference, channel.removecolormatting, generate.fill, generate.gradientramp, perspective.dropshadow, stylize.ccthreshold, stylize.ccthresholdrgb, stylize.glow, stylize.posterize, stylize.threshold, transition.iriswipe, transition.linearwipe, transition.radialwipe
