import * as THREE from 'three';
import { Effect, BlendFunction } from 'postprocessing';

/**
 * @file Whites the frame when a strobe fires at the camera.
 *
 * Half of what makes a strobe read is what it does to the eye, and no amount
 * of light on the floor does that. This adds one colour over the whole frame:
 * how much every strobe together is hitting the camera this frame, worked out
 * by `Strobe.cameraWash` from each flash's brightness, distance, aim and
 * whether it is in view.
 *
 * It sits in the composer before bloom and tone mapping, so the add is in
 * linear light and the tone curve is what turns a big one into white, the way
 * a camera's sensor saturates. Added afterwards it would be a grey veil.
 */

const FRAGMENT = /* glsl */`
  uniform vec3 wash;

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    outputColor = vec4(wash, inputColor.a);
  }
`;

class StrobeWashEffect extends Effect {
  constructor() {
    super('StrobeWashEffect', FRAGMENT, {
      // Added to the frame as it stands; the library's add does not clamp.
      blendFunction: BlendFunction.ADD,
      uniforms: new Map([
        ['wash', new THREE.Uniform(new THREE.Color(0, 0, 0))],
      ]),
    });
  }

  /**
   * Sets this frame's wash.
   *
   * @public
   * @param {Object} colour THREE.Color, linear
   */
  setWash(colour) {
    this.uniforms.get('wash').value.copy(colour);
  }
}

export default StrobeWashEffect;
