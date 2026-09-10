import * as THREE from 'three';

/**
 * @file What a fixture's casing is made of, in any colour.
 *
 * Every generic kind has a body -- a bar's profile, a projector's case, a
 * display's bezel, a laser's chassis -- and the colour of it is part of the
 * fixture's definition, chosen when it is created. What stays with the kind is
 * the *finish*: how rough and how metallic the surface is, and how much light
 * it keeps in an unlit room.
 *
 * That last one is the projector's lesson (see `projector.js`): a lit material
 * in a dark scene reflects nothing, and a dark body on a dark ground has no
 * silhouette. Each kind keeps a small emissive floor so its unlit faces do not
 * collapse into the background. The floor used to be a fixed colour per kind;
 * it is now a fraction of the body colour -- the `lift` -- worked in sRGB, so a
 * kind's own default colour comes out as it always did and a colour someone
 * picks keeps the same relationship.
 */

/** A colour as a definition stores it. */
const HEX = /^#[0-9a-f]{6}$/i;

/**
 * A colour, if it is one a definition can hold.
 *
 * @public
 * @param {*} value
 * @returns {String|null} `#rrggbb`, lower case
 */
export function hexColour(value) {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null;
}

export default class BodyFinish {
  /**
   * @param {Object} spec
   * @param {String} spec.colour the kind's default body colour, `#rrggbb` --
   *   worn by any definition written before it could say its own
   * @param {Number} spec.roughness
   * @param {Number} spec.metalness
   * @param {Number} [spec.lift] 0-1, the emissive floor as a fraction of the
   *   body colour
   */
  constructor({
    colour, roughness, metalness, lift = 0,
  }) {
    this.colour = colour;
    this.roughness = roughness;
    this.metalness = metalness;
    this.lift = lift;
    /**
     * One material per colour in use, shared by every body wearing it: a rig
     * of forty identical projectors is forty meshes and one material.
     */
    this._materials = new Map();
  }

  /**
   * The colour a definition asked for, or this kind's own.
   *
   * @public
   * @param {*} requested what the definition says -- anything
   * @returns {String} `#rrggbb`
   */
  colourOf(requested) {
    return hexColour(requested) || this.colour;
  }

  /**
   * The material for a body of this colour.
   *
   * @public
   * @param {*} requested what the definition says; the kind's own colour when
   *   it says nothing usable
   * @returns {THREE.MeshStandardMaterial}
   */
  material(requested) {
    const colour = this.colourOf(requested);
    let material = this._materials.get(colour);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color: colour,
        roughness: this.roughness,
        metalness: this.metalness,
      });
      if (this.lift > 0) {
        const srgb = material.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
        material.emissive.setRGB(
          srgb.r * this.lift,
          srgb.g * this.lift,
          srgb.b * this.lift,
          THREE.SRGBColorSpace,
        );
      }
      this._materials.set(colour, material);
    }
    return material;
  }
}
