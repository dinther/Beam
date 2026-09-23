import EntityManager from './entityManager.model';

// TODO: Fetching these from EntityManager would be nicer
/**
 * Entity Hertz unit
 *
 * @constant {String} ENTITY_UNIT_HZ
 */
const ENTITY_UNIT_HZ = 'Hz';
// const ENTITY_UNIT_BPM   = "bpm";
// const ENTITY_UNIT_DIST  = "m";
/**
 * Entity Round Per Minutes unit
 *
 * @constant {String} ENTITY_UNIT_RPM
 */
const ENTITY_UNIT_RPM = 'rpm';
/**
 * Entity percent unit
 *
 * @constant {String} ENTITY_UNIT_PERC
 */
const ENTITY_UNIT_PERC = '%';
// const ENTITY_UNIT_S     = "s";
/**
 * Entity millisecond unit
 *
 * @constant {String} ENTITY_UNIT_MS
 */
const ENTITY_UNIT_MS = 'ms';
// const ENTITY_UNIT_LM    = "lm";
/**
 * Entity Kelvin unit
 *
 * @constant {String} ENTITY_UNIT_K
 */
const ENTITY_UNIT_K = 'K';
// const ENTITY_UNIT_M3MIN = "m^3/min";
/**
 * Entity Degree unit
 *
 * @constant {String} ENTITY_UNIT_DEG
 */
const ENTITY_UNIT_DEG = 'deg';
/**
 * Entity no unit
 *
 * @constant ENTITY_UNIT_NONE
 */
const ENTITY_UNIT_NONE = null;

/**
 * Ranged capability property start pattern
 *
 * @constant {String} RANGED_CAPABILITY_PATTERN_START
 */
const RANGED_CAPABILITY_PATTERN_START = 'Start';
/**
 * Ranged capability property end pattern
 *
 * @constant {String} RANGED_CAPABILITY_PATTERN_END
 */
const RANGED_CAPABILITY_PATTERN_END = 'End';

/**
 * Minimum DMX channel value
 *
 * @constant {Number} MIN_DMX_VALUE
 */
const MIN_DMX_VALUE = 0;
/**
 * Maximum DMX channel value
 *
 * @constant {Number} MAX_DMX_VALUE
 */
const MAX_DMX_VALUE = 255;
/**
 * Default capability DMX value range
 *
 * @constant {Array} DEFAULT_CAPABILITY_RANGE
 */
const DEFAULT_CAPABILITY_RANGE = [
  MIN_DMX_VALUE,
  MAX_DMX_VALUE,
];
/**
 * Shutter effect values enumeration
 *
 * @constant {Object} SHUTTER_EFFECTS
 * @enum {String}
 */
const SHUTTER_EFFECTS = {
  OPEN: 'Open',
  CLOSED: 'Closed',
  STROBE: 'Strobe',
  PULSE: 'Pulse',
  RAMP_UP: 'RampUp',
  RAMP_DOWN: 'RampDown',
  RAMP_UP_DOWN: 'RampUpDown',
  LIGHTNING: 'Lightning',
  SPIKES: 'Spikes',
};
/**
 * Default suhtter effect value
 *
 * @constant {String} SHUTER_EFFECTS_DEFAULT
 */
const SHUTER_EFFECTS_DEFAULT = SHUTTER_EFFECTS.OPEN;
/**
 * Default strobe soundcontrol activation value
 *
 * @constant {Boolean} SHUTTER_STROBE_SOUNDCONTROL_DEFAULT
 */
const SHUTTER_STROBE_SOUNDCONTROL_DEFAULT = false;
/**
 * Default strobe randomtimnig activation value
 *
 * @constant {Boolean} SHUTTER_STROBE_SOUNDCONTROL_DEFAULT
 */
const SHUTTER_STROBE_RANDOMTIMING_DEFAULT = false;
/**
 * Default color value for color intensity
 *
 * @constant {String} COLOR_INTENSITY_COLOR_DEFAULT
 */
const COLOR_INTENSITY_COLOR_DEFAULT = 'red';
/**
 * Default colorpreset value
 *
 * @constant COLOR_PRESET_COLOR_DEFAULT
 */
const COLOR_PRESET_COLOR_DEFAULT = null;
/**
 * List of configurations of available capability types
 *
 * @constant {Object} CAPABILITY_TYPES
 * @see https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/capability-types.md
 */
const CAPABILITY_TYPES = {
  ShutterStrobe: {
    shutterEffect: {
      alias: 'strobeEffect',
      default: SHUTER_EFFECTS_DEFAULT,
    },
    soundControlled: {
      alias: 'shutterStrobeSoundControlled',
      default: SHUTTER_STROBE_SOUNDCONTROL_DEFAULT,
    },
    speed: {
      alias: 'strobeFrequency',
      entity: EntityManager.entities.Speed,
      unit: ENTITY_UNIT_HZ,
      min: 0,
      max: 10,
    },
    duration: {
      alias: 'strobeDuration',
      entity: EntityManager.entities.Time,
      unit: ENTITY_UNIT_MS,
      min: 0,
      max: 1000,
    },
    randomTiming: {
      alias: 'strobeRandom',
      default: SHUTTER_STROBE_RANDOMTIMING_DEFAULT,
    },
  },
  StrobeSpeed: {
    speed: {
      alias: 'strobeFrequency',
      entity: EntityManager.entities.Speed,
      unit: ENTITY_UNIT_HZ,
      min: 0,
      max: 10,
    },
  },
  StrobeDuration: {
    speed: {
      alias: 'strobeDuration',
      entity: EntityManager.entities.Time,
      unit: ENTITY_UNIT_MS,
      min: 0,
      max: 1000,
    },
  },
  Intensity: {
    brightness: {
      alias: 'intensity',
      entity: EntityManager.entities.Brightness,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 1,
    },
  },
  ColorIntensity: {
    color: {
      alias: 'color',
      default: COLOR_INTENSITY_COLOR_DEFAULT,
    },
    brightness: {
      alias: 'colorBrightness',
      entity: EntityManager.entities.Brightness,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 1,
    },
  },
  ColorPreset: {
    colors: {
      alias: 'color',
      default: COLOR_PRESET_COLOR_DEFAULT,
    },
    colorTemperature: {
      alias: 'colorTemperature',
      entity: EntityManager.entities.ColorTemperature,
      unit: ENTITY_UNIT_K,
      min: 0,
      max: 100,
    },
  },
  ColorTemperature: {
    colorTemperature: {
      alias: 'colorTemperature',
      entity: EntityManager.entities.ColorTemperature,
      unit: ENTITY_UNIT_K,
      min: 0,
      max: 100,
    },
  },
  Pan: {
    angle: {
      alias: 'pan',
      entity: EntityManager.entities.RotationAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  PanFine: {
    angle: {
      alias: 'panFine',
      isFine: true,
      entity: EntityManager.entities.RotationAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  PanContinuous: {
    speed: {
      alias: 'panContinuousSpeed',
      entity: EntityManager.entities.RotationSpeed,
      unit: ENTITY_UNIT_RPM,
      min: 0,
      max: 360,
    },
  },
  Tilt: {
    angle: {
      alias: 'tilt',
      entity: EntityManager.entities.RotationAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  TiltFine: {
    angle: {
      alias: 'tiltFine',
      isFine: true,
      entity: EntityManager.entities.RotationAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  TiltContinuous: {
    speed: {
      alias: 'tiltContinuousSpeed',
      entity: EntityManager.entities.RotationSpeed,
      unit: ENTITY_UNIT_RPM,
      min: 0,
      max: 360,
    },
  },
  PanTiltSpeed: {
    speed: {
      alias: 'panTiltSpeed',
      entity: EntityManager.entities.Speed,
      unit: ENTITY_UNIT_RPM,
      min: 0,
      max: 360,
    },
    duration: {
      alias: 'panTiltDuration',
      entity: EntityManager.entities.Time,
      unit: ENTITY_UNIT_MS,
      min: 0,
      max: 1000,
    },
  },
  WheelSlot: {
    wheel: {
      alias: 'wheel',
      default: '',
    },
    slotNumber: {
      alias: 'slotNumber',
      entity: EntityManager.entities.SlotNumber,
      unit: ENTITY_UNIT_NONE,
      min: 0,
      max: 0,
    },
  },
  WheelShake: {
    isShaking: {
      alias: 'isShaking',
      default: 'wheel',
    },
    wheel: {
      alias: 'wheel',
      default: '',
    },
    slotNumber: {
      alias: 'slotNumber',
      entity: EntityManager.entities.SlotNumber,
      unit: ENTITY_UNIT_NONE,
      min: 0,
      max: 0,
    },
    shakeSpeed: {
      alias: 'shakeSpeed',
      entity: EntityManager.entities.Speed,
      unit: ENTITY_UNIT_RPM,
      min: 0,
      max: 360,
    },
    shakeAngle: {
      alias: 'shakeAngle',
      entity: EntityManager.entities.SwingAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 90,
    },
  },
  // A gobo spinning in its slot. Speed is a signed percent, -100 fast CCW to
  // 100 fast CW, taken as the profile states it (0..100 maps percent onto
  // itself), of the fixture's own range, since a profile says "slow CW" or "fast CCW" and only the
  // fixture knows what those are in turns a minute; the head maps it onto
  // its min and max. An explicit angle is in degrees.
  WheelSlotRotation: {
    wheel: {
      alias: 'wheel',
      default: '',
    },
    speed: {
      alias: 'speed',
      entity: EntityManager.entities.RotationSpeed,
      optional: true,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 100,
    },
    angle: {
      alias: 'angle',
      entity: EntityManager.entities.RotationAngle,
      optional: true,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  // The whole wheel turning, gobos scrolling past. Same units as above.
  WheelRotation: {
    wheel: {
      alias: 'wheel',
      default: '',
    },
    speed: {
      alias: 'speed',
      entity: EntityManager.entities.RotationSpeed,
      optional: true,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 100,
    },
    angle: {
      alias: 'angle',
      entity: EntityManager.entities.RotationAngle,
      optional: true,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  // A prism in the beam. Carries nothing; the type is the message.
  Prism: {
    comment: {
      alias: 'comment',
      default: '',
    },
  },
  PrismRotation: {
    speed: {
      alias: 'speed',
      entity: EntityManager.entities.RotationSpeed,
      optional: true,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 100,
    },
    angle: {
      alias: 'angle',
      entity: EntityManager.entities.RotationAngle,
      optional: true,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 360,
    },
  },
  Effect: {

  },
  BeamAngle: {
    angle: {
      alias: 'angle',
      entity: EntityManager.entities.BeamAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 90,
    },
  },
  BeamPosition: {
    horizontalAngle: {
      alias: 'pan',
      entity: EntityManager.entities.HorizontalAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 90,
    },
    verticalAngle: {
      alias: 'tilt',
      entity: EntityManager.entities.VerticalAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 90,
    },
  },
  EffectSpeed: {
    speed: {
      alias: 'effectSpeed',
      entity: EntityManager.entities.Speed,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 360,
    },
  },
  EffectDuration: {
    speed: {
      alias: 'effectDuration',
      entity: EntityManager.entities.Duration,
      unit: ENTITY_UNIT_MS,
      min: 0,
      max: 360,
    },
  },
  EffectPrameter: {
    speed: {
      alias: 'effectParameter',
      entity: EntityManager.entities.Parameter,
      unit: ENTITY_UNIT_NONE,
      min: 0,
      max: 100,
    },
  },
  SoundSensitivity: {

  },
  Focus: {
    angle: {
      alias: 'focus',
      entity: EntityManager.entities.Distance,
      unit: ENTITY_UNIT_PERC,
      min: 0,
      max: 100,
    },
  },
  Zoom: {
    angle: {
      alias: 'zoom',
      entity: EntityManager.entities.BeamAngle,
      unit: ENTITY_UNIT_DEG,
      min: 0,
      max: 100,
    },
  },
};

/**
 * Capability class instance
 *
 * @class Capability
 * @classdesc Describes a DMX channel capability
 * @see https://github.com/OpenLightingProject/open-fixture-library/blob/master/docs/capability-types.md
 */
class Capability {
  /**
   * Creates an instance of Capability.
   *
   * @param {Object} capabilityData capability configuration
   */
  constructor(capabilityData) {
    this.type = capabilityData.type;
    this.range = capabilityData.dmxRange || DEFAULT_CAPABILITY_RANGE;
    this.entities = {};
    this.parameters = {};
    this.isFine = false;
    this.init(capabilityData);
  }

  /**
   * Capability's minimum value
   *
   * @readonly
   * @type {Number}
   */
  get min() {
    return this.entities[Object.keys(this.entities)[0]].start;
  }

  /**
   * Capability's maximum value
   *
   * @readonly
   * @type {Number}
   */
  get max() {
    const entityKeys = Object.keys(this.entities);
    return this.entities[entityKeys[entityKeys.length - 1]].end;
  }

  /**
   * Initialises capability using provided configuration
   *
   * @public
   * @param {Object} capabilityData capability configuration object
   */
  init(capabilityData) {
    const capabilitySettings = CAPABILITY_TYPES[this.type];
    if (capabilitySettings) {
      Object.keys(capabilitySettings).forEach((feature) => {
        const setting = capabilitySettings[feature];
        const alias = setting.alias || feature;
        this.isFine = setting.isFine || false;
        if (setting.entity) {
          const entityValue = capabilityData[feature];
          const entityValueStart = capabilityData[feature + RANGED_CAPABILITY_PATTERN_START];
          const entityValueStop = capabilityData[feature + RANGED_CAPABILITY_PATTERN_END];
          // An optional feature the profile says nothing about is absent, not
          // "all of it": a rotation capability states a speed or an angle,
          // and filling in the other would make every range claim both.
          if (setting.optional && !entityValue && !entityValueStart && !entityValueStop) return;
          this.entities[alias] = this.entities[alias] || {};
          if (entityValue) {
            this.entities[alias].value = setting.entity.getValue(
              entityValue,
              setting.unit,
              setting.min,
              setting.max,
            );
          }
          if (entityValueStart) {
            this.entities[alias].start = setting.entity.getValue(
              entityValueStart,
              setting.unit,
              setting.min,
              setting.max,
            );
          }
          if (entityValueStop) {
            this.entities[alias].end = setting.entity.getValue(
              entityValueStop,
              setting.unit,
              setting.min,
              setting.max,
            );
          }
          if (!entityValue && !entityValueStart && !entityValueStop) {
            // Said nothing, so it means all of it. The bounds are already in
            // the units this feature is measured in, so they are taken as they
            // are rather than spelled back into a string for parsing, which
            // would make `max` read as a literal `1%`.
            this.entities[alias].start = setting.min;
            this.entities[alias].end = setting.max;
          }
        } else {
          this.parameters[alias] = capabilityData[feature] || setting.default;
        }
      });
    }
  }

  /**
   * Returns capability value from DMX channel value
   *
   * @public
   * @param {Number} DMXValue DMX channel value
   */
  getValue(DMXValue) {
    const value = {};
    Object.keys(this.entities).forEach((entityName) => {
      value[entityName] = this.getEntityValue(
        this.entities[entityName],
        DMXValue,
        this.isFine,
      );
    });
    Object.keys(this.parameters).forEach((parameterName) => {
      value[parameterName] = this.parameters[parameterName];
    });
    return value;
  }

  /**
   * Fetches entity value from provided DMX channel value
   *
   * @public
   * @param {Object} entity Entity
   * @param {Number} DMXValue DMX channel value
   * @param {Boolean} isFine WHether or not the DMX channel is a fine channel
   */
  getEntityValue(entity, DMXValue, isFine) {
    const perc = this.getPercentValue(DMXValue);
    return Capability.getValueInInterval(entity, perc, isFine);
  }

  /**
   * Creates percentage from value
   *
   * @public
   * @param {Number} value DMX channel value
   * @return {Number} percent-converted value
   */
  getPercentValue(value) {
    // A range of a single DMX value, [0, 0] say, is one setting: 0/0 would
    // be NaN, and a NaN angle blanks every beam and pool that reads it.
    const span = this.range[1] - this.range[0];
    return span === 0 ? 0 : (value - this.range[0]) / span;
  }

  /**
   * Returns a percentage's value scaled on entity's [start,end] interval
   *
   * @public
   * @param {Object} entity handle to entity instance
   * @param {Number} percent percentage to be scaled
   * @param {Boolean} isFine WHether or not the DMX channel is a fine channel
   * @returns {Number} percented value scaled in entity's value interval
   */
  static getValueInInterval(entity, percent, isFine) {
    const fineDiv = isFine ? 255 : 1;
    // A stated value of zero -- "stop" -- is a value, not an absent one.
    const val = entity.value !== undefined ? entity.value
      : ((entity.start / fineDiv) + ((entity.end / fineDiv) - (entity.start / fineDiv)) * percent);
    return val;
  }
}

export default Capability;
