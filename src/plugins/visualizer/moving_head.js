import * as THREE from 'three';
import Light from './light';

/**
 * @file A moving head: a light on a yoke. The yoke pans on the base and the
 * head tilts in the yoke; the light's lens is in the head, so its beam goes
 * where pan and tilt put it. Everything about the light itself is `Light`'s.
 */

/**
 * How fast a head slews, in degrees per second.
 *
 * A real head accelerates and decelerates, and how long a move takes depends on
 * the fixture. None of that is simulated: this is a flat rate, chosen to look
 * plausible rather than to match any particular mover. A GDTF fixture replaces it
 * with the rate its file gives, its full travel over its RealFade.
 *
 * @constant {Number}
 */
const PAN_SPEED_DEG_PER_SEC = 270;
const TILT_SPEED_DEG_PER_SEC = 210;

/**
 * Largest time step the slew will honour, in seconds.
 *
 * The update clock reports elapsed time, so a stalled frame -- an alt-tab, a
 * blocked main thread -- would otherwise arrive as one enormous step and let the
 * head teleport, which is the behaviour this exists to prevent.
 *
 * @constant {Number}
 */
const MAX_STEP_SECONDS = 0.1;

/**
 * The slowest a pan/tilt speed channel moves a head, as a share of its top
 * speed: at 270 degrees a second, a full 540 degree pan takes 100 seconds.
 * Profiles say only "slow"; this is Beam's figure.
 */
const PAN_TILT_SLOWEST = 0.02;

/** Writes a matrix into an object's position, rotation and scale. */
function setLocal(object, matrix) {
  matrix.decompose(object.position, object.quaternion, object.scale);
}

class MovingHead extends Light {
  /**
   * Creates a moving head.
   *
   * @param {Object} data as a light's, with `{ minPan, maxPan, minTilt,
   *   maxTilt, pan, tilt, panSpeed, tiltSpeed }`: the travel in degrees, where
   *   it starts, and its top speeds in degrees a second
   */
  constructor(data = {}) {
    super(data);
    this.minTilt = data.minTilt || 0;
    this.maxTilt = data.maxTilt || 0;
    this.minPan = data.minPan || 0;
    this.maxPan = data.maxPan || 0;
    this._panSpeed = data.panSpeed || PAN_SPEED_DEG_PER_SEC;
    this._tiltSpeed = data.tiltSpeed || TILT_SPEED_DEG_PER_SEC;
    // What a pan/tilt speed channel asks for, or null for full speed; see
    // `setPanTiltSpeed`.
    this._panTiltSpeed = null;
    // A timed move in progress: the target it was timed for and the rates
    // that get there together. See `updateOrientation`.
    this._move = null;
    this.pan = data.pan;
    this.tilt = data.tilt;
    // Built pointing where the desk already asks for, rather than slewing in
    // from zero every time a show loads.
    this.snapOrientation();
  }

  /**
   * The yoke and the head: where each hangs at rest, and the node that turns
   * it. Identity at rest for the shipped body, whose parts all pivot at the
   * origin; a GDTF body sets the rest frames from its file in `mountJoints`.
   *
   * @protected
   * @returns {THREE.Object3D} the head, which carries the lens
   */
  buildJoints() {
    this._yokeMount = new THREE.Object3D();
    this._yokeDummy = new THREE.Object3D();
    this._headMount = new THREE.Object3D();
    this._headDummy = new THREE.Object3D();
    this._bodyRoot.add(this._yokeMount);
    this._yokeMount.add(this._yokeDummy);
    this._yokeDummy.add(this._headMount);
    this._headMount.add(this._headDummy);
    return this._headDummy;
  }

  /**
   * Sets the yoke and head where the file hangs them, and answers the tilt
   * pivot, which goes to the fixture's origin, where the shipped body pivots,
   * so a head keeps the place it was given.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {THREE.Matrix4}
   */
  mountJoints(body) {
    setLocal(this._yokeMount, body.yokeFrame);
    setLocal(this._headMount, body.headFrame);
    return body.yokeFrame.clone().multiply(body.headFrame);
  }

  /**
   * The base, and the yoke and head at rest.
   *
   * @protected
   * @param {Object} body
   * @returns {Array} `[geometry, matrix]` pairs
   */
  restingParts(body) { // eslint-disable-line class-methods-use-this
    return [
      [body.base, new THREE.Matrix4()],
      [body.yoke, body.yokeFrame.clone()],
      [body.head, body.yokeFrame.clone().multiply(body.headFrame)],
    ];
  }

  /**
   * The base, and the yoke and head as pan and tilt pose them.
   *
   * @protected
   * @returns {Object} `{ base, yoke, head }`
   */
  posedParts() {
    return { base: this._bodyRoot, yoke: this._yokeDummy, head: this._headDummy };
  }

  /**
   * Takes on what another mode states: its pan and tilt travel, and the
   * light's own inputs.
   *
   * @public
   * @param {Object} inputs `{ maxPan, maxTilt }`, and a light's
   */
  setModeInputs(inputs) {
    this.maxPan = inputs.maxPan || 0;
    this.maxTilt = inputs.maxTilt || 0;
    super.setModeInputs(inputs);
  }

  /**
   * As a light's, and full pan/tilt speed.
   *
   * @public
   */
  resetOptics() {
    super.resetOptics();
    this.setPanTiltSpeed(null);
  }

  /**
   * Pan value in degrees
   *
   * @type {Number}
   */
  set pan(panAngle) {
    this._pan = panAngle;
  }

  get pan() {
    return this._pan || 0.0;
  }

  /**
   * Pan-fine value in degrees
   *
   * @type {Number}
   */
  set panFine(fineAngle) {
    this._panFine = fineAngle;
  }

  get panFine() {
    return this._panFine || 0.0;
  }

  /**
   * Tilt value in degrees
   *
   * @type {Number}
   */
  set tilt(tiltAngle) {
    this._tilt = tiltAngle;
  }

  get tilt() {
    return this._tilt || 0.0;
  }

  /**
   * Tilt-fine value in degrees
   *
   * @type {Number}
   */
  set tiltFine(fineAngle) {
    this._tiltFine = fineAngle;
  }

  get tiltFine() {
    return this._tiltFine || 0.0;
  }

  /**
   * Slew rate in degrees per second.
   *
   * @readonly
   * @type {Number}
   */
  get panSpeed() {
    return this._panSpeed;
  }

  get tiltSpeed() {
    return this._tiltSpeed;
  }

  /**
   * Sets how fast pan and tilt move, from a pan/tilt speed channel.
   *
   * A speed is a percent, slow to fast, of the fixture's top speeds, with
   * the slow end assumed. A share is a measured fraction of the top speeds,
   * as a fixture file states it. A duration is the time every move takes
   * whatever its size, pan and tilt arriving together; zero is as fast as
   * the head goes.
   *
   * @public
   * @param {Object|null} value `{ speed, share, duration }`, one of them
   *   stated, or null for full speed
   */
  setPanTiltSpeed(value) {
    const speed = value && Number.isFinite(value.speed) ? value.speed : null;
    const share = value && Number.isFinite(value.share) ? value.share : null;
    const duration = value && Number.isFinite(value.duration) ? value.duration : null;
    if (speed === null && share === null && duration === null) {
      this._panTiltSpeed = null;
    } else if (duration !== null) {
      this._panTiltSpeed = { share: 1, duration: Math.max(duration, 0) };
    } else if (share !== null) {
      this._panTiltSpeed = { share: Math.min(Math.max(share, 0), 1), duration: 0 };
    } else {
      const fraction = Math.min(Math.max(speed, 0), 100) / 100;
      this._panTiltSpeed = {
        share: PAN_TILT_SLOWEST + fraction * (1 - PAN_TILT_SLOWEST),
        duration: 0,
      };
    }
    this._move = null;
  }

  /**
   * Angle the desk is asking for, coarse and fine combined.
   *
   * @readonly
   * @type {Number}
   */
  get targetPan() {
    return this.pan + this.panFine;
  }

  get targetTilt() {
    return this.tilt + this.tiltFine;
  }

  /**
   * Writes the current angles onto the yoke and head.
   *
   * @public
   */
  applyOrientation() {
    this._yokeDummy.rotation.z = Light.degToRad(this._panCurrent - this.maxPan / 2);
    this._headDummy.rotation.x = Light.degToRad(this._tiltCurrent - this.maxTilt / 2);
    this._matrixNeedsUpdate = true;
  }

  /**
   * Jumps straight to the requested angles, skipping the slew. For construction
   * and for anything that repositions a fixture rather than driving it.
   *
   * @public
   */
  snapOrientation() {
    this._panCurrent = this.targetPan;
    this._tiltCurrent = this.targetTilt;
    this.applyOrientation();
  }

  /**
   * Moves the head toward the requested angles at its slew rate.
   *
   * @public
   * @param {Number} t seconds since the animation clock started
   */
  updateOrientation(t) {
    const previous = this._lastUpdateTime;
    this._lastUpdateTime = t;
    if (previous === undefined) return;

    const step = Math.min(t - previous, MAX_STEP_SECONDS);
    if (step <= 0) return;

    const panError = this.targetPan - this._panCurrent;
    const tiltError = this.targetTilt - this._tiltCurrent;
    if (panError === 0 && tiltError === 0) {
      this._move = null;
      return;
    }

    // Top speeds, scaled by a speed channel. A timed move works out its rates
    // once, when the target changes, so each axis covers its distance in the
    // stated time; a head cannot go faster than its top speed however short
    // the time.
    let panRate = this._panSpeed;
    let tiltRate = this._tiltSpeed;
    const setting = this._panTiltSpeed;
    if (setting && setting.duration > 0) {
      const move = this._move;
      if (!move || move.pan !== this.targetPan || move.tilt !== this.targetTilt) {
        this._move = {
          pan: this.targetPan,
          tilt: this.targetTilt,
          panRate: Math.min(Math.abs(panError) / setting.duration, this._panSpeed),
          tiltRate: Math.min(Math.abs(tiltError) / setting.duration, this._tiltSpeed),
        };
      }
      panRate = this._move.panRate;
      tiltRate = this._move.tiltRate;
    } else if (setting) {
      panRate *= setting.share;
      tiltRate *= setting.share;
    }
    const panLimit = panRate * step;
    const tiltLimit = tiltRate * step;

    // Clamped to the remaining error so the head settles exactly on target
    // instead of oscillating around it.
    this._panCurrent += Math.sign(panError) * Math.min(Math.abs(panError), panLimit);
    this._tiltCurrent += Math.sign(tiltError) * Math.min(Math.abs(tiltError), tiltLimit);
    this.applyOrientation();
  }

  /**
   * Moves on by one frame: the slew, then the light.
   *
   * @public
   * @param {Number} t seconds since the animation clock started
   */
  update(t) {
    this.updateOrientation(t);
    super.update(t);
  }
}

/**
 * A light whose head is tilted by hand in its bracket: a moving head's
 * joints, posed from the placement rather than DMX, standing on its file's
 * origin as a light does.
 */
export class HandTiltedLight extends MovingHead {
  /**
   * The joints set from the file; the pivot stays at the file's origin.
   *
   * @protected
   * @param {Object} body from `gdtf_body.js`
   * @returns {THREE.Matrix4}
   */
  mountJoints(body) {
    super.mountJoints(body);
    return new THREE.Matrix4();
  }
}

export default MovingHead;
