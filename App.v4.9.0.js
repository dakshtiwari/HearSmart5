/**
 * HearSmart v4.9 — smartphone pure-tone hearing-screening research prototype
 *
 * IMPORTANT:
 * - This is NOT a clinically calibrated audiometer.
 * - Two modes: the validated pure-tone mode reports estimated dB HL but
 *   only runs when a real acoustic DEVICE_PROFILE exists (none ship yet,
 *   so every device uses Universal Screening Mode today), and Universal
 *   Screening Mode reports only PASS / REFER / INCONCLUSIVE — never dB HL.
 * - Right/left routing is implemented with a stereo PCM WAV.
 * - Threshold rule (pure-tone mode): as soon as 2 responses occur in the
 *   most recent 3 valid ascending trials at a level, that level is
 *   accepted immediately — a 3rd trial is never forced if 2 heard
 *   responses already came in on the first 2 attempts.
 * - This app performs AIR-CONDUCTION screening only, through headphones.
 *   It does NOT perform bone-conduction testing, masking, Rinne, Weber, or
 *   SRT/SDS/SISI/TDT. It cannot determine whether a loss is conductive or
 *   sensorineural — only a licensed audiologist with calibrated equipment
 *   can determine that. The report says so explicitly rather than guessing.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v4.9 CHANGES (dual-mode architecture — validated pure-tone vs. universal
 * tone-in-noise screening — plus screening-audio level tuning)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1) DUAL-MODE ARCHITECTURE: dB HL results are now only ever reported for
 *    a phone+headphone combination with a VALIDATED acoustic profile
 *    (DEVICE_PROFILES — SPL at 0 dBFS measured with real acoustic
 *    equipment, never derived from a test subject's own threshold).
 *    DEVICE_PROFILES ships EMPTY and must only be populated with real
 *    measurements, so every device today automatically routes to
 *    Universal Screening Mode.
 *
 * 2) UNIVERSAL SCREENING MODE: a tone-in-noise test (fixed noise bed +
 *    tone whose SNR adapts trial to trial) that never reports dB HL —
 *    only PASS / REFER / INCONCLUSIVE. Silent catch trials measure
 *    response reliability, and an unreliable run is downgraded to
 *    INCONCLUSIVE instead of being presented as a confident result.
 *
 * 3) SCREENING AUDIO TUNED: the noise-bed level was reduced and the tone
 *    amplitude is now capped to digital headroom so the mixed waveform
 *    can never clip. At high SNR the old code could request a tone
 *    amplitude above full scale (e.g. +18 dB SNR over the old 0.18 bed ≈
 *    1.43×), and the hard clamp then flattened the sine into a harsh
 *    square-ish "ZUUUUU" buzz at 100% system volume. The SNR values the
 *    test adapts are unchanged — only the presentation level is.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v4.8 CHANGES (tightened calibration caps so a real hearing loss cannot
 * be silently absorbed into "device correction")
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A person with clinically-confirmed moderate bilateral hearing loss
 * needed a +60 dB subjective offset to hear the reference tone — and the
 * app silently treated that entire loss as a quiet-device correction,
 * reporting her as within normal limits: a false negative. FIX: the
 * wizard offset is now capped to CALIBRATION_MIN/MAX_OFFSET_DB (±20 dB),
 * a range that plausibly reflects only device/headphone gain variation,
 * and hitting the cap now triggers an explicit warning (in the wizard and
 * in the PDF report) instead of silently clamping.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v4.7 CHANGES (multi-point calibration, floor-effect safeguard, wireless
 * headphone caveat)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1) MULTI-POINT CALIBRATION: calibration is now measured at 250/1000/
 *    4000/8000 Hz and interpolated in log-frequency space for every other
 *    frequency — a single 1 kHz point cannot correct for uneven headphone
 *    frequency response. The stored value is now a JSON profile per
 *    device (AsyncStorage) instead of a single number.
 * 2) FLOOR-EFFECT SAFEGUARD: thresholds accepted at very low digital gain
 *    (≤ DBFS_FLOOR_WARNING_THRESHOLD) are flagged ⚠, since 16-bit
 *    quantization noise can make a clean tone sound thin or glitchy.
 * 3) WIRELESS HEADPHONE CAVEAT: Bluetooth/wireless devices often apply
 *    adaptive EQ/compression that alters faint tones; a heuristic keyword
 *    match surfaces this caveat rather than pretending it doesn't exist.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * v4.6 CHANGES (fixes the iOS crash from v4.5 + enforces calibration before
 * testing so results can no longer be silently near-inaudible)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * 1) IOS CRASH FIXED: "interruptionModeAndroid was set to an invalid
 *    value". v4.5 tried to guard the Android-only interruption-mode
 *    constant with a try/catch, but reading a missing property doesn't
 *    throw in JS — it just evaluates to `undefined`, which the native
 *    Audio module then rejected. Worse, that assignment ran on EVERY
 *    platform, including iOS, where `interruptionModeAndroid` is not a
 *    valid key at all. FIX: the interruption-mode key is now chosen
 *    per-platform (`interruptionModeAndroid` only on Android,
 *    `interruptionModeIOS` only on iOS), and is only attached if the
 *    constant resolves to an actual number — never assigned as
 *    `undefined`.
 *
 * 2) CALIBRATION IS NOW ENFORCED, NOT OPTIONAL: v4.5 built a calibration
 *    wizard but nothing stopped a tester from skipping it and running the
 *    real test with `calibrationOffsetDb = 0`. Because the base SPL table
 *    is only a rough placeholder (105 dB @ 0 dBFS), an unconfirmed
 *    calibration means most requested levels (e.g. 40 dB HL) render at
 *    roughly -60 dBFS — effectively inaudible on real headphones — which
 *    is exactly the "nothing until ~70 dB" symptom. FIX: "Begin hearing
 *    test" and the practice-tone flow now hard-require
 *    `calibrationSavedForDevice === true`; if calibration hasn't been
 *    confirmed, the tester is routed back to the calibration wizard
 *    instead of being allowed to proceed with a meaningless offset.
 *
 * 3) FASTER CALIBRATION WIZARD: the wizard used a fixed 2 dB step, so a
 *    device that needs +40-50 dB of correction required 20+ taps just to
 *    become audible. FIX: adaptive step size — steps start large (6 dB)
 *    while the tone is still far from audible and automatically shrink to
 *    2 dB once the tester starts going back and forth (an oscillation
 *    around the true threshold), which is the standard bracketing
 *    approach used for hunting a threshold quickly and then refining it.
 *
 * (v4.5 changes retained below for reference.)
 * v4.5: forced audio routing away from the earpiece
 * (`playThroughEarpieceAndroid: false`), switched all tone WAVs from
 * 24-bit to 16-bit PCM for reliable cross-OEM Android decoding, replaced
 * the hand-edited Android SPL table with a persisted per-device
 * calibration offset (AsyncStorage), clamped `dbHLToAmplitude` instead of
 * throwing when a level exceeds digital headroom, and rebuilt the PDF to
 * mirror a real clinical pure-tone-audiogram form (separate Right/Left
 * panels, PTA/SRT/SDS/SISI/TDT table, demographics, auto-generated
 * provisional diagnosis, explicit conductive-vs-sensorineural caveat).
 *
 * Required packages:
 *   npx expo install expo-av expo-print expo-sharing expo-device react-native-svg expo-dev-client expo-build-properties
 *   npm install react-native-volume-manager@2.0.8 base64-arraybuffer @react-native-async-storage/async-storage
 *
 * NOTE: react-native-volume-manager requires a custom Expo development
 * client — it will NOT work inside Expo Go.
 */

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  SafeAreaView,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import { Audio } from 'expo-av';
import * as Device from 'expo-device';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { VolumeManager } from 'react-native-volume-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encode as encodeBase64 } from 'base64-arraybuffer';
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const APP_VERSION = '4.9.0';

// Both platforms use the same model: system volume is set to maximum once
// (manually confirmed on iOS, automatically set + verified on Android) and
// held there; all per-tone loudness control happens digitally.
const TARGET_VOLUME = 1.0;
const VOLUME_TOLERANCE = 0.025;

const MIN_DB = -10;
// A conservative prototype ceiling because generic headphones are uncalibrated.
const MAX_DB = 80;
// Starting level for the very first trial of each test run. 40 dB HL is
// comfortably audible for the vast majority of people (only
// moderate-or-worse losses would miss it), so the test starts fast and
// still brackets down/up from there.
const DEFAULT_START_DB = 40;
const STEP_UP = 5;
const STEP_DOWN = 10;
const TONE_DURATION_SEC = 1.2;
const RAMP_MS = 50;

// v4.5/4.6: calibration wizard constants.
const CALIBRATION_REFERENCE_DB_HL = 30;
const CALIBRATION_REFERENCE_FREQ = 1000;
// v4.6: adaptive step size. We start coarse so a device needing a big
// correction (e.g. +40-50 dB) reaches audibility quickly, then switch to a
// fine step once the tester reverses direction (a sign we're bracketing
// the real threshold), same principle as the ascending/descending logic
// used in the main test.
const CALIBRATION_COARSE_STEP_DB = 6;
const CALIBRATION_FINE_STEP_DB = 2;
// v4.8: TIGHTENED CAPS. A real test on a person with documented,
// clinically-confirmed moderate bilateral hearing loss (PTA ~43-45 dB HL)
// needed a +60 dB calibration offset to make the reference tone audible —
// and the app then silently absorbed that entire loss into "device
// correction," reporting her as within normal limits. A wide offset range
// doesn't just correct device/headphone gain differences (which are
// realistically a handful of dB, not tens of dB) — it can absorb an
// entire real hearing loss and erase it from the result, which is a false
// negative and the most dangerous failure mode a screening tool can have.
// FIX: cap the range tightly enough to plausibly reflect only device/
// headphone gain variation. If a tester needs more correction than this
// to hear the reference tone, that is far more likely to be a real
// finding than a quiet phone, and the wizard must say so explicitly
// rather than silently clamping and continuing (see
// CALIBRATION_LIMIT_REACHED handling in adjustCalibration/confirmCalibrationStep).
const CALIBRATION_MIN_OFFSET_DB = -20;
const CALIBRATION_MAX_OFFSET_DB = 20;
const CALIBRATION_STORAGE_PREFIX = 'hearsmart_calibration_offset_v1_';

// ─────────────────────────────────────────────────────────────────────────────
// v4.9: DEVICE PROFILE DATABASE + DUAL-MODE ARCHITECTURE
//
// Real test data (an iPhone+AirPods run and an Android+wired run from the
// same normal-hearing tester, plus a second test against a person with
// clinically-confirmed moderate bilateral hearing loss) showed that
// subjective, tester-adjusted calibration cannot reliably separate "quiet
// device" from "real hearing difference" — in one case it silently
// absorbed an entire real hearing loss into "device correction."
//
// The fix is architectural, not another calibration tweak: dB HL is only
// ever reported for a phone+headphone combination with a VALIDATED
// profile — SPL-at-0-dBFS values measured with real acoustic equipment
// (sound-level meter + coupler), never derived from a test subject's own
// threshold. DEVICE_PROFILES ships EMPTY. No profile in this codebase has
// been measured, so by default every tester is routed to Universal
// Screening Mode below, which never reports dB HL at all. Populate this
// object only with entries backed by real measurements — do not fill it
// with guessed numbers to make the pure-tone mode "turn on."
//
// Example shape (NOT real data — for structure reference only):
// const DEVICE_PROFILES = {
//   'ios__iPhone_14_Pro_Max__AirPods_Pro_2__bluetooth': {
//     validated: true,
//     measuredAt: '2026-08-01',
//     splAtZeroDbfs: { 250: 101.2, 500: 103.1, 1000: 105.0, 2000: 104.4,
//                       3000: 102.8, 4000: 100.9, 6000: 98.7, 8000: 96.4 },
//   },
// };
// ─────────────────────────────────────────────────────────────────────────────
const DEVICE_PROFILES = {};

function getDeviceProfileKey({ phoneModel, headphoneModel, connectionType }) {
  return [Platform.OS, phoneModel, headphoneModel, connectionType]
    .map((value) => String(value || 'unknown').trim().replace(/[^a-zA-Z0-9]/g, '_'))
    .join('__');
}

function lookupDeviceProfile(key) {
  const profile = DEVICE_PROFILES[key];
  return profile?.validated ? profile : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL SCREENING MODE (used whenever no validated device profile
// exists — i.e. by default, for every phone/headphone combination today).
//
// This is NOT a pure-tone dB HL test and never reports one. Instead of
// asking "how quiet can you go," it presents a fixed-level tone mixed
// into a fixed-level noise bed and adapts the TONE-TO-NOISE RATIO (SNR)
// until the tone is reliably detectable. An SNR-based measure is far
// less sensitive to unknown absolute device/headphone output level than
// an absolute-dB test, which is why it's usable without any acoustic
// calibration at all — the same principle behind validated tools like
// WHO's hearWHO, which use digits-in-noise rather than pure tones for
// exactly this reason. This app uses a tone-in-noise signal rather than
// recorded spoken digits (which would require licensed speech material
// this app does not have) — a reasonable proxy, but not equivalent to a
// validated digits-in-noise test, so results are reported only as
// PASS / REFER / INCONCLUSIVE with a reliability score, never as a
// clinical-sounding number or degree-of-loss label.
// ─────────────────────────────────────────────────────────────────────────────
const SCREENING_FREQUENCIES = [1000, 2000, 4000];
const SCREENING_START_SNR_DB = 6;
const SCREENING_STEP_DB = 3;
const SCREENING_MIN_SNR_DB = -12;
const SCREENING_MAX_SNR_DB = 18;
const SCREENING_TRIALS_PER_FREQUENCY = 6;
const SCREENING_CATCH_TRIAL_PROBABILITY = 0.2;
// An SNR threshold above this (tone needed to be louder than the noise
// bed by more than this many dB) at any tested frequency triggers REFER
// for that ear. This is a coarse, unvalidated cut point pending real
// comparison against clinical outcomes — see the in-app and report
// disclaimers, which say so explicitly.
const SCREENING_REFER_SNR_DB = 4;
// If more than this fraction of silent catch trials get a "heard"
// response, the tester is very likely pressing the button reflexively
// rather than genuinely responding to sound — the result is marked
// unreliable rather than trusted.
const SCREENING_RELIABLE_FALSE_POSITIVE_MAX = 0.3;
// v4.9: peak amplitude of the white-noise bed in the Universal Screening
// signal, expressed as a fraction of digital full scale. This is a TUNING
// CONSTANT, not a measured value: 0.18 (the v4.8 value) was
// uncomfortably loud through headphones at 100% system volume and, mixed
// with the tone at high SNR, drove the waveform past full scale into
// harsh clipping distortion (the "ZUUUUU" sound). 0.06 keeps the bed
// clearly audible as a steady hiss while leaving enough headroom for the
// loudest tone this protocol uses (+18 dB SNR → tone ≈ 0.48, worst-case
// mix peak ≈ 0.54, comfortably under 1.0). Re-measure with real
// headphones + a sound-level meter before trusting the absolute level —
// the SNR measure itself is level-agnostic, so this only affects comfort,
// not the test result.
const SCREENING_NOISE_AMPLITUDE = 0.06;

// v4.7: floor-effect safeguard. 16-bit PCM has roughly a 96 dB dynamic
// range. Once a requested tone's digital gain drops below this dBFS
// value, the sine wave is represented by so few quantization steps that
// it may sound thin, glitchy, or partly masked by quantization noise —
// which can make a normal-hearing tester report "not heard" at a level
// they would actually hear fine on a cleaner signal. Any accepted
// threshold that required gain at/below this value is flagged as
// FLOOR-LIMITED rather than trusted at face value.
const DBFS_FLOOR_WARNING_THRESHOLD = -85;

// v4.7: Bluetooth / wireless earbuds and headsets (AirPods, Galaxy Buds,
// most true-wireless models) commonly apply adaptive EQ, dynamic range
// compression, or noise-dependent volume shaping that is NOT a flat gain.
// The calibration wizard only measures accuracy at one reference point
// (30 dB HL @ 1 kHz), so it cannot detect or correct frequency- and
// level-dependent processing on these devices. Faint near-threshold tones
// are exactly the kind of low-level content such processing is most
// likely to alter, which can push every threshold up (falsely suggesting
// loss) even in normal-hearing testers. This is a heuristic keyword match
// on the headphone description field, not a hardware detection — it
// exists to surface the caveat, not to block testing.
const WIRELESS_HEADPHONE_KEYWORDS = [
  'airpod', 'buds', 'bluetooth', 'wireless', 'beats', 'bose qc',
  'sony wh', 'sony wf', 'pixel buds', 'jabra', 'powerbeats',
];

function isLikelyWirelessHeadphone(description) {
  const text = (description || '').toLowerCase();
  return WIRELESS_HEADPHONE_KEYWORDS.some((keyword) => text.includes(keyword));
}

// v4.7: MULTI-POINT CALIBRATION. A single 1 kHz reference point cannot
// correct for the fact that real transducers (phone speakers, bundled
// earphones, Bluetooth earbuds) have uneven frequency response — low and
// high frequencies are commonly reproduced at very different relative
// loudness than 1 kHz. Comparing real test runs on two different devices
// showed exactly this shape of error: thresholds consistently worst at
// 250/500 Hz on BOTH an iPhone+AirPods run and an Android+wired run from
// the same (self-reported normal-hearing) tester — evidence of a shared
// systematic calibration gap rather than random error or real hearing
// loss. FIX: calibrate at several frequencies spanning the tested range
// and interpolate (in log-frequency space, matching how the audiogram
// x-axis itself is drawn) between them for every other frequency.
const CALIBRATION_FREQUENCIES = [250, 1000, 4000, 8000];

// Given a calibration profile (a map of { frequency: offsetDb } for some
// subset of CALIBRATION_FREQUENCIES) and a target frequency, returns the
// interpolated/extrapolated offset to use at that frequency. Frequencies
// outside the calibrated range use the nearest calibrated point's offset
// (flat extrapolation) rather than guessing a trend beyond measured data.
function getOffsetForFrequency(profile, targetFreq) {
  const points = CALIBRATION_FREQUENCIES.filter(
    (freq) => typeof profile?.[freq] === 'number',
  ).sort((a, b) => a - b);

  if (points.length === 0) return 0;
  if (points.length === 1) return profile[points[0]];

  if (targetFreq <= points[0]) return profile[points[0]];
  if (targetFreq >= points[points.length - 1]) return profile[points[points.length - 1]];

  for (let index = 0; index < points.length - 1; index += 1) {
    const lowFreq = points[index];
    const highFreq = points[index + 1];
    if (targetFreq >= lowFreq && targetFreq <= highFreq) {
      const t =
        (Math.log10(targetFreq) - Math.log10(lowFreq)) /
        (Math.log10(highFreq) - Math.log10(lowFreq));
      return profile[lowFreq] + t * (profile[highFreq] - profile[lowFreq]);
    }
  }

  return 0;
}

function isCalibrationProfileComplete(profile) {
  return CALIBRATION_FREQUENCIES.every((freq) => typeof profile?.[freq] === 'number');
}

// v4.8: true if any calibrated frequency required the maximum/minimum
// allowed offset to become audible — a sign that the "normal" range of
// this result may not be trustworthy, since it could reflect the
// tester's own reduced sensitivity rather than a quiet device.
function hasCalibrationLimitWarning(limitReachedMap) {
  return Object.values(limitReachedMap ?? {}).some(Boolean);
}

function formatCalibrationProfile(profile) {
  return CALIBRATION_FREQUENCIES
    .map((freq) => {
      const value = profile?.[freq];
      if (typeof value !== 'number') return `${formatFrequency(freq)}: not calibrated`;
      return `${formatFrequency(freq)}: ${value > 0 ? '+' : ''}${value} dB`;
    })
    .join(', ');
}

const RIGHT_COLOR = '#E53935';
const LEFT_COLOR = '#2563EB';
const ACCENT = '#00C9A7';

const BASE_STEPS = [
  { id: '1000_initial', freq: 1000, label: '1k' },
  { id: '2000', freq: 2000, label: '2k' },
  { id: '3000', freq: 3000, label: '3k' },
  { id: '4000', freq: 4000, label: '4k' },
  { id: '6000', freq: 6000, label: '6k' },
  { id: '8000', freq: 8000, label: '8k' },
  { id: '1000_retest', freq: 1000, label: '1k↺' },
  { id: '500', freq: 500, label: '500' },
  { id: '250', freq: 250, label: '250' },
];

const STEP_2000_RECHECK = {
  id: '2000_recheck',
  freq: 2000,
  label: '2k↺',
};

// Values taken from the professor-provided SPL/HL reference table.
// These are reference SPL values for 0 dB HL, not a generic-headphone calibration.
const ZERO_HL_REFERENCE_SPL = {
  250: 12,
  500: 5,
  1000: 2,
  2000: -2,
  3000: -3, // interpolated estimate
  4000: -5,
  6000: 0,  // interpolated estimate
  8000: 13,
};

const INTERPOLATED_FREQUENCIES = new Set([3000, 6000]);

// Measured engineering profile: SPL produced at 0 dBFS (a full-scale digital
// tone) when the system volume is at 100%, for iOS.
//
// IMPORTANT: this single-point measurement was taken at 1 kHz and reused for
// every frequency. Headphone frequency response is not flat, so for a more
// accurate prototype, repeat the same SLM measurement at 250 Hz, 500 Hz,
// 2 kHz, 3 kHz, 4 kHz, 6 kHz and 8 kHz and enter each value below instead of
// reusing 105 for all of them.
const PROTOTYPE_SPL_AT_0_DBFS = {
  250: 105,
  500: 105,
  1000: 105,
  2000: 105,
  3000: 105,
  4000: 105,
  6000: 105,
  8000: 105,
};

// v4.5: Android base table. This is STILL just a starting point (105 dB @
// 0 dBFS, same single-point-at-1kHz caveat as above) — but you no longer
// need to hand-edit this before a demo. The in-app calibration wizard
// (phase: 'calibrate') measures a per-device OFFSET on top of this base
// table and persists it via AsyncStorage, keyed by device model. See
// loadCalibrationOffset / saveCalibrationOffset below.
const ANDROID_PROTOTYPE_SPL_AT_0_DBFS = {
  250: 105,
  500: 105,
  1000: 105,
  2000: 105,
  3000: 105,
  4000: 105,
  6000: 105,
  8000: 105,
};

// ─────────────────────────────────────────────────────────────────────────────
// Per-device calibration storage
// ─────────────────────────────────────────────────────────────────────────────

function getCalibrationDeviceKey() {
  const model = (Device.modelName ?? 'unknown-device').replace(/[^a-zA-Z0-9]/g, '_');
  return `${Platform.OS}_${model}`;
}

// v4.7: the stored value is now a JSON-encoded profile
// ({ frequency: offsetDb, ... }) covering CALIBRATION_FREQUENCIES, instead
// of a single number.
async function loadCalibrationProfile(deviceKey) {
  try {
    const raw = await AsyncStorage.getItem(`${CALIBRATION_STORAGE_PREFIX}${deviceKey}`);
    if (raw == null) return {};
    const parsed = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object') return {};
    const clean = {};
    for (const freq of CALIBRATION_FREQUENCIES) {
      if (typeof parsed[freq] === 'number' && Number.isFinite(parsed[freq])) {
        clean[freq] = parsed[freq];
      }
    }
    return clean;
  } catch (_) {
    return {};
  }
}

async function saveCalibrationProfile(deviceKey, profile) {
  try {
    await AsyncStorage.setItem(
      `${CALIBRATION_STORAGE_PREFIX}${deviceKey}`,
      JSON.stringify(profile),
    );
    return true;
  } catch (_) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Result helpers
// ─────────────────────────────────────────────────────────────────────────────

function thresholdResult(db, floorLimited = false) {
  return { kind: 'threshold', db, floorLimited };
}

function noResponseResult(maxDb) {
  return { kind: 'no_response', maxDb };
}

function resultDb(result) {
  return result?.kind === 'threshold' ? result.db : null;
}

// ASHA-style adult degree-of-hearing-loss grading (a common convention —
// not the only clinical standard, and final grading is the assessing
// audiologist's call, not this app's).
function classify(db) {
  if (db == null) return null;
  if (db <= 25) {
    return {
      shortLabel: 'Normal',
      label: 'Within normal screening range',
      color: '#059669',
      recommendation: 'Repeat screening periodically or sooner if symptoms develop.',
    };
  }
  if (db <= 40) {
    return {
      shortLabel: 'Mild',
      label: 'Mild hearing loss',
      color: '#D97706',
      recommendation: 'A professional audiology assessment is recommended.',
    };
  }
  if (db <= 55) {
    return {
      shortLabel: 'Moderate',
      label: 'Moderate hearing loss',
      color: '#EA580C',
      recommendation: 'Arrange a professional audiology and ENT assessment.',
    };
  }
  if (db <= 70) {
    return {
      shortLabel: 'Moderately severe',
      label: 'Moderately severe hearing loss',
      color: '#DC2626',
      recommendation: 'Prompt professional audiology and ENT assessment is recommended.',
    };
  }
  if (db <= 90) {
    return {
      shortLabel: 'Severe',
      label: 'Severe hearing loss',
      color: '#991B1B',
      recommendation: 'Prompt professional audiology and ENT assessment is recommended.',
    };
  }
  return {
    shortLabel: 'Profound',
    label: 'Profound hearing loss',
    color: '#7F1D1D',
    recommendation: 'Urgent professional audiology and ENT assessment is recommended.',
  };
}

function getAccepted1000Db(earResults) {
  const initial = resultDb(earResults?.['1000_initial']);
  const retest = resultDb(earResults?.['1000_retest']);

  if (initial == null) return retest;
  if (retest == null) return initial;

  return Math.abs(initial - retest) > 5
    ? Math.min(initial, retest)
    : initial;
}

function is1000RetestReliable(earResults) {
  const initial = resultDb(earResults?.['1000_initial']);
  const retest = resultDb(earResults?.['1000_retest']);

  if (initial == null || retest == null) return null;
  return Math.abs(initial - retest) <= 5;
}

function needs2000Recheck(earResults) {
  return is1000RetestReliable(earResults) === false;
}

// v4.7: how many accepted thresholds for this ear were floor-limited
// (i.e. required digital gain at or below the 16-bit quantization-noise
// warning threshold). A non-zero count means part of this ear's PTA may
// be inflated by signal-quality artifacts rather than true hearing
// sensitivity, and should be shown alongside the result rather than
// presented as a clean clinical finding.
function countFloorLimitedResults(earResults = {}) {
  return Object.values(earResults).filter(
    (result) => result?.kind === 'threshold' && result.floorLimited,
  ).length;
}

function getStepsForEar(ear, earResults = {}) {
  if (ear === 'left') {
    // ASHA: a 1000-Hz retest is not necessary for the second ear.
    return BASE_STEPS.filter((step) => step.id !== '1000_retest');
  }

  const steps = [...BASE_STEPS];
  if (needs2000Recheck(earResults)) {
    const retestIndex = steps.findIndex((item) => item.id === '1000_retest');
    steps.splice(retestIndex + 1, 0, STEP_2000_RECHECK);
  }
  return steps;
}

function acceptedResultForFrequency(earResults, frequency) {
  if (frequency === 1000) {
    const db = getAccepted1000Db(earResults);
    return db == null ? earResults?.['1000_initial'] ?? null : thresholdResult(db);
  }

  return earResults?.[String(frequency)] ?? null;
}

function computeFourFrequencyPTA(earResults) {
  const values = [
    resultDb(earResults?.['500']),
    getAccepted1000Db(earResults),
    resultDb(earResults?.['2000']),
    resultDb(earResults?.['4000']),
  ];

  if (values.some((value) => value == null)) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function suggestedStartDb(previousResult) {
  const db = resultDb(previousResult);
  if (db == null) return DEFAULT_START_DB;
  return Math.max(MIN_DB, Math.min(40, db - 10));
}

// v4.9: turns raw screening trial data (per-ear/per-frequency SNR
// thresholds + the catch-trial log) into a PASS/REFER/INCONCLUSIVE
// summary. Reliability is checked FIRST and overrides everything else —
// an unreliable run should never be presented as a confident pass.
function computeScreeningSummary(screeningResults, catchLog) {
  const catchTotal = catchLog.length;
  const falsePositives = catchLog.filter((entry) => entry.heard).length;
  const falsePositiveRate = catchTotal > 0 ? falsePositives / catchTotal : 0;
  const reliable =
    catchTotal === 0 || falsePositiveRate <= SCREENING_RELIABLE_FALSE_POSITIVE_MAX;

  function earOutcome(earResults) {
    const values = SCREENING_FREQUENCIES.map((freq) => earResults?.[freq]);
    if (values.some((value) => typeof value !== 'number')) return null;
    const worstSnr = Math.max(...values);
    return worstSnr > SCREENING_REFER_SNR_DB ? 'REFER' : 'PASS';
  }

  return {
    rightOutcome: earOutcome(screeningResults?.right ?? {}),
    leftOutcome: earOutcome(screeningResults?.left ?? {}),
    reliable,
    falsePositiveRate,
    catchTotal,
    falsePositives,
  };
}

function formatFrequency(freq) {
  return freq >= 1000 ? `${freq / 1000} kHz` : `${freq} Hz`;
}

function formatResult(result) {
  if (!result) return '—';
  if (result.kind === 'no_response') return `NR at ${result.maxDb} dB`;
  return `${result.db} dB${result.floorLimited ? ' ⚠' : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// v4.5: auto-generated provisional diagnosis line, in the spirit of the
// clinical form ("Bilateral Moderate degree of hearing loss...") but
// honest about what this app can and cannot determine: it never claims a
// conductive/sensorineural split, since that needs bone conduction.
function buildProvisionalDiagnosis(rightPta, leftPta) {
  const rightClass = classify(rightPta);
  const leftClass = classify(leftPta);
  const caveat = 'type of loss (conductive vs. sensorineural) not determined — bone conduction not performed';

  if (rightPta == null && leftPta == null) {
    return 'PTA not available for either ear — provisional diagnosis cannot be generated.';
  }
  if (rightPta != null && leftPta != null) {
    if (rightClass.shortLabel === leftClass.shortLabel) {
      if (rightClass.shortLabel === 'Normal') {
        return `Bilateral hearing within normal screening limits on air-conduction pure-tone screening (${caveat}).`;
      }
      return `Bilateral ${rightClass.shortLabel.toLowerCase()} degree hearing loss on air-conduction pure-tone screening (${caveat}).`;
    }
    return `Asymmetric hearing loss on air-conduction pure-tone screening — Right: ${rightClass.shortLabel}, Left: ${leftClass.shortLabel} (${caveat}).`;
  }

  const knownSide = rightPta != null ? 'Right' : 'Left';
  const cls = rightPta != null ? rightClass : leftClass;
  return `${knownSide} ear: ${cls.shortLabel.toLowerCase()} degree hearing loss on air-conduction pure-tone screening; opposite ear incomplete (${caveat}).`;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPL → estimated dB HL prototype mapping
//
// Both iOS and Android compute the requested digital amplitude the same
// way — the calibration table picks the platform's base SPL-at-0dBFS
// value, and calibrationOffsetDb (measured once per device via the
// in-app wizard, see 'calibrate' phase) shifts it. A HIGHER offset means
// LOUDER output for the same requested dB HL.
// ─────────────────────────────────────────────────────────────────────────────

function dbHLToAmplitude(dbHL, frequencyHz, calibrationProfile = {}) {
  const zeroHlSpl = ZERO_HL_REFERENCE_SPL[frequencyHz];
  const splTable =
    Platform.OS === 'android' ? ANDROID_PROTOTYPE_SPL_AT_0_DBFS : PROTOTYPE_SPL_AT_0_DBFS;
  const baseSplAtZeroDbfs = splTable[frequencyHz];

  if (zeroHlSpl == null || baseSplAtZeroDbfs == null) {
    throw new Error(`Missing calibration entry for ${frequencyHz} Hz.`);
  }

  // v4.7: resolve the per-device correction at THIS frequency by
  // interpolating between the multi-point calibration profile, instead of
  // reusing a single 1 kHz measurement everywhere.
  const calibrationOffsetDb = getOffsetForFrequency(calibrationProfile, frequencyHz);

  // A positive calibrationOffsetDb makes the device louder for the same
  // requested dB HL, which is achieved by treating the device as if it
  // produces LESS SPL at 0 dBFS than the base table says (so more digital
  // gain is needed to reach the same target SPL).
  const effectiveSplAtZeroDbfs = baseSplAtZeroDbfs - calibrationOffsetDb;

  const targetSpl = dbHL + zeroHlSpl;
  let dBFS = targetSpl - effectiveSplAtZeroDbfs;

  // Clamp instead of throw. During a live test/demo we would rather play
  // back at the loudest the device can currently do (and flag it as
  // clipped) than silently fail to play anything at all.
  const clipped = dBFS > 0;
  if (clipped) dBFS = 0;

  return {
    amplitude: Math.pow(10, dBFS / 20),
    targetSpl,
    dBFS,
    clipped,
  };
}

// Used by the report/PDF and in-test screen to show the target SPL and
// dBFS attenuation actually used for a given accepted result. Pure
// re-derivation from (frequency, dB HL) using the exact same function that
// drives real playback, so it is guaranteed to match what was actually
// played — there is no separate log that could fall out of sync.
function volumeLabelForResult(freq, result, calibrationProfile = {}) {
  if (!result) return null;
  const db = result.kind === 'no_response' ? result.maxDb : result.db;
  try {
    const { targetSpl, dBFS, clipped } = dbHLToAmplitude(db, freq, calibrationProfile);
    return `${dBFS.toFixed(1)} dBFS (target ${Math.round(targetSpl)} dB SPL)${clipped ? ' — at device max' : ''}`;
  } catch {
    return null;
  }
}

// 16-bit PCM. Android's decoder stack has inconsistent support for 24-bit
// PCM inside a WAV container across OEMs — some play it back much quieter
// than intended, some not at all. 16-bit PCM is universally supported on
// both platforms and is more than enough resolution for a pure sine tone
// at these durations.
function writePcm16(view, offset, signedValue) {
  view.setInt16(offset, signedValue, true);
}

function buildStereoWav(
  frequencyHz,
  dbHL,
  ear,
  calibrationProfile = {},
  durationSec = TONE_DURATION_SEC,
) {
  if (ear !== 'left' && ear !== 'right') {
    throw new Error('Ear must be "left" or "right".');
  }

  const sampleRate = 44100;
  const channels = 2;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const numSamples = Math.floor(sampleRate * durationSec);
  const rampSamples = Math.floor(sampleRate * (RAMP_MS / 1000));
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const { amplitude } = dbHLToAmplitude(dbHL, frequencyHz, calibrationProfile);

  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const max16 = 0x7fff;

  for (let index = 0; index < numSamples; index += 1) {
    let envelope = 1;

    if (index < rampSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * index) / rampSamples));
    } else if (index >= numSamples - rampSamples) {
      const remaining = numSamples - 1 - index;
      envelope = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));
    }

    const sine = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
    const sample = Math.round(amplitude * envelope * sine * max16);
    const clamped = Math.max(-max16 - 1, Math.min(max16, sample));

    const left = ear === 'left' ? clamped : 0;
    const right = ear === 'right' ? clamped : 0;
    const offset = 44 + index * blockAlign;

    writePcm16(view, offset, left);
    writePcm16(view, offset + bytesPerSample, right);
  }

  return encodeBase64(buffer);
}

// v4.9: signal for Universal Screening Mode. Unlike buildStereoWav, this
// does NOT go through dbHLToAmplitude or any calibration profile — it
// deliberately uses a fixed digital presentation level for every tester
// on every device, because this mode's whole point is not depending on
// knowing the device's real acoustic output. Only the tone-to-noise
// AMPLITUDE RATIO changes per trial, driven directly by snrDb. A catch
// trial renders noise only (toneAmplitude = 0) to test for false
// positives.
function buildToneInNoiseWav(frequencyHz, snrDb, ear, isCatchTrial, durationSec = 1.8) {
  if (ear !== 'left' && ear !== 'right') {
    throw new Error('Ear must be "left" or "right".');
  }

  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const numSamples = Math.floor(sampleRate * durationSec);
  const rampSamples = Math.floor(sampleRate * (RAMP_MS / 1000));
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const noiseAmplitude = SCREENING_NOISE_AMPLITUDE;
  // Headroom protection: never let the tone push the mixed waveform past
  // digital full scale. A clipped sine stops being a tone — the hard clamp
  // below flattens its peaks into a harsh square-ish "ZUUUUU" buzz, and at
  // high SNR the uncapped formula can exceed 1.0 (e.g. +18 dB SNR over the
  // old 0.18 noise bed ≈ 1.43×). Capping the tone at (1 - noiseAmplitude)
  // guarantees the worst-case peak of tone + noise stays ≤ 1.0 while every
  // SNR level this protocol uses (-12..+18 dB) stays fully representable;
  // the per-sample clamp below remains as a safety net for rare random
  // noise peaks. The tone-to-noise RATIO is untouched by this cap.
  const maxToneAmplitude = Math.max(0, 1 - noiseAmplitude);
  const toneAmplitude = isCatchTrial
    ? 0
    : Math.min(noiseAmplitude * Math.pow(10, snrDb / 20), maxToneAmplitude);
  const max16 = 0x7fff;

  for (let index = 0; index < numSamples; index += 1) {
    let envelope = 1;
    if (index < rampSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * index) / rampSamples));
    } else if (index >= numSamples - rampSamples) {
      const remaining = numSamples - 1 - index;
      envelope = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));
    }

    const noiseSample = (Math.random() * 2 - 1) * noiseAmplitude;
    const toneSample = toneAmplitude * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
    const mixed = (noiseSample + toneSample) * envelope;
    const clamped = Math.max(-1, Math.min(1, mixed));
    const intSample = Math.round(clamped * max16);

    const left = ear === 'left' ? intSample : 0;
    const right = ear === 'right' ? intSample : 0;
    const offset = 44 + index * blockAlign;

    writePcm16(view, offset, left);
    writePcm16(view, offset + bytesPerSample, right);
  }

  return encodeBase64(buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audiogram (app, combined overview)
// ─────────────────────────────────────────────────────────────────────────────

function Audiogram({ rightResults, leftResults }) {
  const { width: windowWidth } = useWindowDimensions();
  const width = Math.max(300, Math.min(windowWidth - 48, 560));
  const height = 280;
  const padLeft = 42;
  const padRight = 16;
  const padTop = 18;
  const padBottom = 34;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;

  const frequencies = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
  const dbLines = [-10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80];

  const xFor = (frequency) =>
    padLeft +
    (Math.log10(frequency / 250) / Math.log10(8000 / 250)) * plotWidth;

  const yFor = (db) =>
    padTop + ((db - MIN_DB) / (MAX_DB - MIN_DB)) * plotHeight;

  const makePoints = (results) =>
    frequencies.map((frequency) => {
      const result = acceptedResultForFrequency(results, frequency);
      if (!result) return null;

      const isNr = result.kind === 'no_response';
      const db = isNr ? result.maxDb : result.db;
      return {
        frequency,
        x: xFor(frequency),
        y: yFor(db),
        db,
        isNr,
      };
    });

  const rightPoints = makePoints(rightResults);
  const leftPoints = makePoints(leftResults);

  const pathFor = (points) => {
    const thresholdPoints = points.filter((point) => point && !point.isNr);
    if (thresholdPoints.length < 2) return '';
    return thresholdPoints
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
      .join(' ');
  };

  return (
    <Svg width={width} height={height}>
      <Rect
        x={padLeft}
        y={yFor(MIN_DB)}
        width={plotWidth}
        height={yFor(25) - yFor(MIN_DB)}
        fill="#ECFDF5"
      />

      {frequencies.map((frequency) => (
        <React.Fragment key={`fx-${frequency}`}>
          <Line
            x1={xFor(frequency)}
            y1={padTop}
            x2={xFor(frequency)}
            y2={height - padBottom}
            stroke="#D6DEE8"
            strokeWidth="1"
          />
          <SvgText
            x={xFor(frequency)}
            y={height - 12}
            fontSize="9"
            fill="#64748B"
            textAnchor="middle"
          >
            {frequency >= 1000 ? `${frequency / 1000}k` : frequency}
          </SvgText>
        </React.Fragment>
      ))}

      {dbLines.map((db) => (
        <React.Fragment key={`db-${db}`}>
          <Line
            x1={padLeft}
            y1={yFor(db)}
            x2={width - padRight}
            y2={yFor(db)}
            stroke={db === 25 ? '#86EFAC' : '#D6DEE8'}
            strokeWidth={db === 25 ? '1.5' : '1'}
          />
          <SvgText
            x={padLeft - 6}
            y={yFor(db) + 3}
            fontSize="9"
            fill="#64748B"
            textAnchor="end"
          >
            {db}
          </SvgText>
        </React.Fragment>
      ))}

      <SvgText x={padLeft + 4} y={yFor(25) - 5} fontSize="8" fill="#059669">
        Screening range ≤25 dB
      </SvgText>

      {pathFor(rightPoints) ? (
        <Path d={pathFor(rightPoints)} stroke={RIGHT_COLOR} strokeWidth="2" fill="none" />
      ) : null}
      {pathFor(leftPoints) ? (
        <Path d={pathFor(leftPoints)} stroke={LEFT_COLOR} strokeWidth="2" fill="none" />
      ) : null}

      {rightPoints.map((point) => {
        if (!point) return null;
        return (
          <React.Fragment key={`r-${point.frequency}`}>
            <Circle
              cx={point.x}
              cy={point.y}
              r="6"
              fill="#FFFFFF"
              stroke={RIGHT_COLOR}
              strokeWidth="2"
            />
            {point.isNr ? (
              <>
                <Line
                  x1={point.x}
                  y1={point.y + 7}
                  x2={point.x}
                  y2={point.y + 17}
                  stroke={RIGHT_COLOR}
                  strokeWidth="2"
                />
                <Path
                  d={`M ${point.x - 4} ${point.y + 13} L ${point.x} ${point.y + 18} L ${point.x + 4} ${point.y + 13}`}
                  stroke={RIGHT_COLOR}
                  strokeWidth="2"
                  fill="none"
                />
              </>
            ) : null}
          </React.Fragment>
        );
      })}

      {leftPoints.map((point) => {
        if (!point) return null;
        return (
          <React.Fragment key={`l-${point.frequency}`}>
            <Line
              x1={point.x - 6}
              y1={point.y - 6}
              x2={point.x + 6}
              y2={point.y + 6}
              stroke={LEFT_COLOR}
              strokeWidth="2"
            />
            <Line
              x1={point.x + 6}
              y1={point.y - 6}
              x2={point.x - 6}
              y2={point.y + 6}
              stroke={LEFT_COLOR}
              strokeWidth="2"
            />
            {point.isNr ? (
              <>
                <Line
                  x1={point.x}
                  y1={point.y + 8}
                  x2={point.x}
                  y2={point.y + 18}
                  stroke={LEFT_COLOR}
                  strokeWidth="2"
                />
                <Path
                  d={`M ${point.x - 4} ${point.y + 14} L ${point.x} ${point.y + 19} L ${point.x + 4} ${point.y + 14}`}
                  stroke={LEFT_COLOR}
                  strokeWidth="2"
                  fill="none"
                />
              </>
            ) : null}
          </React.Fragment>
        );
      })}

      <SvgText
        x="10"
        y={height / 2}
        fontSize="9"
        fill="#64748B"
        textAnchor="middle"
        transform={`rotate(-90 10 ${height / 2})`}
      >
        Estimated dB HL
      </SvgText>
    </Svg>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF audiogram — separate Right / Left panels, matching a real clinical
// pure-tone-audiogram form instead of one merged chart.
// ─────────────────────────────────────────────────────────────────────────────

function buildEarAudiogramSvg(ear, results) {
  const width = 260;
  const height = 250;
  const padLeft = 40;
  const padRight = 14;
  const padTop = 28;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const frequencies = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
  const dbLines = [-10, 0, 10, 20, 25, 30, 40, 50, 60, 70, 80];
  const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
  const title = ear === 'right' ? 'RIGHT (O)' : 'LEFT (X)';

  const xFor = (frequency) =>
    padLeft + (Math.log10(frequency / 250) / Math.log10(8000 / 250)) * plotWidth;
  const yFor = (db) => padTop + ((db - MIN_DB) / (MAX_DB - MIN_DB)) * plotHeight;

  const points = frequencies
    .map((frequency) => {
      const result = acceptedResultForFrequency(results, frequency);
      if (!result) return null;
      const isNr = result.kind === 'no_response';
      const db = isNr ? result.maxDb : result.db;
      return { frequency, x: xFor(frequency), y: yFor(db), isNr };
    })
    .filter(Boolean);

  const validPoints = points.filter((point) => !point.isNr);
  const path =
    validPoints.length >= 2
      ? validPoints.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`).join(' ')
      : '';

  const grid = [
    ...frequencies.map(
      (frequency) => `
        <line x1="${xFor(frequency)}" y1="${padTop}" x2="${xFor(frequency)}" y2="${height - padBottom}" stroke="#d7dee7" stroke-width="1"/>
        <text x="${xFor(frequency)}" y="${height - 10}" text-anchor="middle" font-size="8" fill="#64748b">${frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text>
      `,
    ),
    ...dbLines.map(
      (db) => `
        <line x1="${padLeft}" y1="${yFor(db)}" x2="${width - padRight}" y2="${yFor(db)}" stroke="${db === 25 ? '#86efac' : '#d7dee7'}" stroke-width="${db === 25 ? 1.3 : 0.8}"/>
        <text x="${padLeft - 5}" y="${yFor(db) + 3}" text-anchor="end" font-size="8" fill="#64748b">${db}</text>
      `,
    ),
  ].join('');

  const marks = points
    .map((point) => {
      if (ear === 'right') {
        return `
          <circle cx="${point.x}" cy="${point.y}" r="5.5" fill="#ffffff" stroke="${color}" stroke-width="2"/>
          ${
            point.isNr
              ? `<line x1="${point.x}" y1="${point.y + 6}" x2="${point.x}" y2="${point.y + 15}" stroke="${color}" stroke-width="2"/>
                 <path d="M${point.x - 3.5},${point.y + 11} L${point.x},${point.y + 16} L${point.x + 3.5},${point.y + 11}" stroke="${color}" stroke-width="2" fill="none"/>`
              : ''
          }
        `;
      }
      return `
        <line x1="${point.x - 5.5}" y1="${point.y - 5.5}" x2="${point.x + 5.5}" y2="${point.y + 5.5}" stroke="${color}" stroke-width="2"/>
        <line x1="${point.x + 5.5}" y1="${point.y - 5.5}" x2="${point.x - 5.5}" y2="${point.y + 5.5}" stroke="${color}" stroke-width="2"/>
        ${
          point.isNr
            ? `<line x1="${point.x}" y1="${point.y + 7}" x2="${point.x}" y2="${point.y + 16}" stroke="${color}" stroke-width="2"/>
               <path d="M${point.x - 3.5},${point.y + 12} L${point.x},${point.y + 17} L${point.x + 3.5},${point.y + 12}" stroke="${color}" stroke-width="2" fill="none"/>`
            : ''
        }
      `;
    })
    .join('');

  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff" stroke="#d7dee7"/>
      <text x="${width / 2}" y="16" text-anchor="middle" font-size="11" font-weight="700" fill="${color}">${title}</text>
      <rect x="${padLeft}" y="${yFor(MIN_DB)}" width="${plotWidth}" height="${yFor(25) - yFor(MIN_DB)}" fill="#ecfdf5"/>
      ${grid}
      ${path ? `<path d="${path}" stroke="${color}" stroke-width="1.6" fill="none"/>` : ''}
      ${marks}
    </svg>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ear indicator (used on every in-test screen so it's always obvious which
// ear is currently being tested)
// ─────────────────────────────────────────────────────────────────────────────

function EarBadge({ ear }) {
  const isRight = ear === 'right';
  const color = isRight ? RIGHT_COLOR : LEFT_COLOR;
  return (
    <View style={[styles.earBadge, { borderColor: color, backgroundColor: `${color}1F` }]}>
      <View style={[styles.earBadgeSymbolWrap, { borderColor: color }]}>
        <Text style={[styles.earBadgeSymbol, { color }]}>{isRight ? 'O' : 'X'}</Text>
      </View>
      <Text style={[styles.earBadgeText, { color }]}>
        {isRight ? 'RIGHT EAR' : 'LEFT EAR'}
      </Text>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume UI components
//
// Android and iOS share identical wording, since both platforms hold
// system volume at a fixed maximum and do all real attenuation digitally.
// Top-level components (not declared inside App) so React can reconcile
// them normally instead of remounting on every render.
// ─────────────────────────────────────────────────────────────────────────────

function VolumeGate({ systemVolume, volumeLoading, volumeReady, onSetTargetVolume }) {
  return (
    <View style={[styles.volumeCard, volumeReady ? styles.volumeReady : styles.volumeNotReady]}>
      <Text style={styles.volumeTitle}>System volume</Text>
      {volumeLoading ? (
        <ActivityIndicator color={ACCENT} />
      ) : (
        <>
          <Text style={styles.volumeNumber}>
            {systemVolume == null ? 'Unavailable' : `${Math.round(systemVolume * 100)}%`}
          </Text>
          <Text style={[styles.volumeStatus, { color: volumeReady ? '#059669' : '#DC2626' }]}>
            {volumeReady ? '✓ Required volume confirmed' : 'Set volume to maximum'}
          </Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={onSetTargetVolume}>
            <Text style={styles.secondaryButtonText}>
              {Platform.OS === 'android' ? 'Set volume to maximum' : 'I set iPhone volume to maximum'}
            </Text>
          </TouchableOpacity>
          <Text style={styles.smallNote}>
            System volume is held at maximum during testing; loudness for each frequency is controlled entirely by digital gain, not by the volume slider.
          </Text>
        </>
      )}
    </View>
  );
}

function VolumeBlockedOverlay({ volumeBlocked, systemVolume, onSetTargetVolume }) {
  if (!volumeBlocked) return null;
  return (
    <View style={styles.blockOverlay}>
      <View style={styles.blockCard}>
        <Text style={styles.blockTitle}>Volume changed — test paused</Text>
        <Text style={styles.blockBody}>
          {Platform.OS === 'android'
            ? 'The test paused because the volume was changed. The tone was cancelled and will not count.'
            : 'Set iPhone volume to maximum. The interrupted tone was cancelled and will not count.'}
        </Text>
        <Text style={styles.blockVolume}>
          Current: {systemVolume == null ? 'unknown' : `${Math.round(systemVolume * 100)}%`}
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onSetTargetVolume}>
          <Text style={styles.primaryButtonText}>
            {Platform.OS === 'android' ? 'Set volume to maximum and resume' : 'Continue after setting max volume'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function EarResults({ ear, results, pta, classification, calibrationProfile }) {
  const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
  const steps = getStepsForEar(ear, results);
  const floorCount = countFloorLimitedResults(results);
  return (
    <View style={[styles.resultCard, { borderColor: `${color}55` }]}>
      <Text style={[styles.resultTitle, { color }]}>
        {ear === 'right' ? 'O Right ear' : 'X Left ear'}
      </Text>
      <Text style={[styles.resultPta, { color: classification?.color ?? '#CBD5E1' }]}>
        {pta == null ? 'PTA unavailable' : `${pta} dB`}
      </Text>
      <Text style={styles.dbUnit}>four-frequency estimated PTA</Text>
      {floorCount > 0 ? (
        <View style={styles.reliabilityBox}>
          <Text style={{ color: '#D97706', fontWeight: '700', textAlign: 'center' }}>
            ⚠ {floorCount} threshold{floorCount > 1 ? 's' : ''} on this ear used near-minimum
            digital gain and may reflect signal quantization noise rather than true hearing
            sensitivity — treat this ear's result with caution, especially with wireless
            headphones.
          </Text>
        </View>
      ) : null}
      {classification ? (
        <>
          <Text style={[styles.classification, { color: classification.color }]}>
            {classification.label}
          </Text>
          <Text style={styles.resultRecommendation}>{classification.recommendation}</Text>
        </>
      ) : null}

      {ear === 'right' && is1000RetestReliable(results) != null ? (
        <View style={styles.reliabilityBox}>
          <Text
            style={{
              color: is1000RetestReliable(results) ? '#059669' : '#D97706',
              fontWeight: '700',
            }}
          >
            {is1000RetestReliable(results)
              ? '✓ 1 kHz retest within 5 dB'
              : '⚠ 1 kHz retest differed by more than 5 dB; lower value accepted and 2 kHz rechecked'}
          </Text>
        </View>
      ) : null}

      <View style={{ width: '100%', marginTop: 12 }}>
        {steps
          .filter((item) => results[item.id])
          .map((item) => {
            const result = results[item.id];
            const volLabel = volumeLabelForResult(item.freq, result, calibrationProfile);
            return (
              <View key={item.id} style={styles.resultRow}>
                <Text style={styles.resultFrequency}>
                  {formatFrequency(item.freq)}
                  {item.id.includes('retest') || item.id.includes('recheck') ? ' ↺' : ''}
                  {INTERPOLATED_FREQUENCIES.has(item.freq) ? ' *' : ''}
                  {volLabel ? `  ·  ${volLabel}` : ''}
                </Text>
                <Text style={styles.resultValue}>{formatResult(result)}</Text>
              </View>
            );
          })}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main app
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [phase, setPhase] = useState('setup');
  const phaseRef = useRef('setup');

  const [participantName, setParticipantName] = useState('');
  const [participantAge, setParticipantAge] = useState('');
  const [participantSex, setParticipantSex] = useState(null); // 'female' | 'male' | 'other'
  const [referredBy, setReferredBy] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [testId, setTestId] = useState('');
  const [headphoneDescription, setHeadphoneDescription] = useState('');
  // v4.9: identify the exact phone+headphone+connection combination so it
  // can be looked up against DEVICE_PROFILES. Together with
  // headphoneDescription and connectionType, this forms the profile key.
  const [phoneModel, setPhoneModel] = useState('');
  const [connectionType, setConnectionType] = useState('wired'); // 'wired' | 'bluetooth'
  // 'calibrated_pure_tone' | 'universal_screening' | null (undecided yet)
  const [testMode, setTestMode] = useState(null);
  const [deviceProfile, setDeviceProfile] = useState(null);
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  // v4.7: ambient noise is a major real-world confound for low-frequency
  // thresholds (250/500 Hz), so this is a required, explicit confirmation
  // rather than just an instructional bullet point.
  const [quietRoomConfirmed, setQuietRoomConfirmed] = useState(false);

  const [systemVolume, setSystemVolume] = useState(null);
  const [volumeLoading, setVolumeLoading] = useState(true);
  const [volumeBlocked, setVolumeBlocked] = useState(false);

  // Per-device calibration profile (dB offsets at several frequencies),
  // persisted via AsyncStorage.
  const [calibrationProfile, setCalibrationProfile] = useState({});
  // v4.8: which CALIBRATION_FREQUENCIES hit CALIBRATION_MIN/MAX_OFFSET_DB
  // during the wizard. Hitting the cap means the tone was still
  // inaudible/uncomfortable at the maximum correction this app will
  // apply — that is far more likely to indicate a real hearing
  // difference than a quiet device, so it must be flagged rather than
  // silently absorbed into the offset.
  const [calibrationLimitReached, setCalibrationLimitReached] = useState({});
  const [calibrationDeviceKey, setCalibrationDeviceKey] = useState(null);
  const [calibrationSavedForDevice, setCalibrationSavedForDevice] = useState(false);
  // v4.7: which of CALIBRATION_FREQUENCIES the wizard is currently on.
  const [calibrationWizardIndex, setCalibrationWizardIndex] = useState(0);
  // tracks the direction of the last calibration nudge so we can
  // detect the tester reversing direction (bracketing the threshold) and
  // shrink the step size automatically.
  const [calibrationStepDb, setCalibrationStepDb] = useState(CALIBRATION_COARSE_STEP_DB);
  const calibrationLastDirectionRef = useRef(null);
  const calibrationReturnPhaseRef = useRef('channel_check');

  const [channelCheck, setChannelCheck] = useState({ right: false, left: false });
  const [channelCheckEar, setChannelCheckEar] = useState(null);

  const [currentEar, setCurrentEar] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [currentDb, setCurrentDb] = useState(DEFAULT_START_DB);
  const currentDbRef = useRef(DEFAULT_START_DB);

  const [practiceDb, setPracticeDb] = useState(30);
  const [practicePassed, setPracticePassed] = useState(false);

  const [isPlaying, setIsPlaying] = useState(false);
  const [tonePlayed, setTonePlayed] = useState(false);
  const [thresholds, setThresholds] = useState({ right: {}, left: {} });
  const thresholdsRef = useRef({ right: {}, left: {} });
  const [history, setHistory] = useState([]);
  const [thresholdBanner, setThresholdBanner] = useState(null);
  const [lastFeedback, setLastFeedback] = useState(null);
  const [ascendingWindowDisplay, setAscendingWindowDisplay] = useState([]);
  const [directionDisplay, setDirectionDisplay] = useState('initial');
  const [hadDescentDisplay, setHadDescentDisplay] = useState(false);

  // ─── v4.9: Universal Screening Mode state ───
  const [screeningEar, setScreeningEar] = useState(null);
  const [screeningFreqIndex, setScreeningFreqIndex] = useState(0);
  const [screeningSnr, setScreeningSnr] = useState(SCREENING_START_SNR_DB);
  const [screeningTonePlayed, setScreeningTonePlayed] = useState(false);
  const [screeningResults, setScreeningResults] = useState({ right: {}, left: {} });
  const [screeningCatchLog, setScreeningCatchLog] = useState([]);
  const screeningSnrRef = useRef(SCREENING_START_SNR_DB);
  const screeningDirectionRef = useRef('none'); // 'none' | 'up' | 'down'
  const screeningReversalsRef = useRef([]);
  const screeningTrialCountRef = useRef(0);
  const screeningIsCatchTrialRef = useRef(false);
  const screeningResultsRef = useRef({ right: {}, left: {} });
  const screeningCatchLogRef = useRef([]);
  const [exporting, setExporting] = useState(false);

  const soundRef = useRef(null);
  const playbackTokenRef = useRef(0);
  const toneCacheRef = useRef(new Map());
  const responseLockedRef = useRef(false);
  const maxMissesRef = useRef(0);
  const transitionTimerRef = useRef(null);
  const feedbackTimerRef = useRef(null);
  const ascendingWindowsRef = useRef({});
  const directionRef = useRef('initial');
  const hadDescentRef = useRef(false);
  const testStartedAtRef = useRef(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  // Both platforms target a fixed max system volume and never move it
  // again during testing.
  const volumeReady =
    systemVolume != null && Math.abs(systemVolume - TARGET_VOLUME) <= VOLUME_TOLERANCE;

  const activeSteps = useMemo(
    () => getStepsForEar(currentEar, thresholds[currentEar] ?? {}),
    [currentEar, thresholds],
  );
  const currentStep = activeSteps[stepIndex] ?? null;
  const currentFrequency = currentStep?.freq ?? 1000;
  const earColor = currentEar === 'right' ? RIGHT_COLOR : LEFT_COLOR;

  const clearTimers = useCallback(() => {
    if (transitionTimerRef.current) {
      clearTimeout(transitionTimerRef.current);
      transitionTimerRef.current = null;
    }
    if (feedbackTimerRef.current) {
      clearTimeout(feedbackTimerRef.current);
      feedbackTimerRef.current = null;
    }
  }, []);

  const stopSound = useCallback(async () => {
    playbackTokenRef.current += 1;
    const sound = soundRef.current;
    soundRef.current = null;

    if (sound) {
      try {
        sound.setOnPlaybackStatusUpdate(null);
        await sound.stopAsync();
      } catch (_) {
        // Sound may already be stopped.
      }
      try {
        await sound.unloadAsync();
      } catch (_) {
        // Sound may already be unloaded.
      }
    }

    setIsPlaying(false);
  }, []);

  const cancelTone = useCallback(async () => {
    await stopSound();
    setTonePlayed(false);
    setScreeningTonePlayed(false);
    responseLockedRef.current = false;
  }, [stopSound]);

  // We still read/monitor system volume so we can detect if the user
  // manually changes it mid-test (physical buttons), which would
  // invalidate calibration — same safety role iOS handles manually. We
  // never move the volume slider ourselves per tone.
  useEffect(() => {
    let isMounted = true;
    let volumeSubscription = null;

    async function initVolumeMonitoring() {
      if (Platform.OS === 'android') {
        try {
          const initial = await VolumeManager.getVolume();
          if (!isMounted) return;

          setSystemVolume(initial.volume);
          setVolumeLoading(false);
          setVolumeBlocked(false);

          volumeSubscription = VolumeManager.addVolumeListener((result) => {
            if (!isMounted) return;
            setSystemVolume(result.volume);
          });
        } catch (error) {
          if (!isMounted) return;
          setVolumeLoading(false);
          Alert.alert(
            'Could not read system volume',
            error?.message ??
              'react-native-volume-manager failed to initialize. Make sure you are running a custom Android dev build, not Expo Go.',
          );
        }
      } else {
        setSystemVolume(TARGET_VOLUME);
        setVolumeLoading(false);
        setVolumeBlocked(false);
      }
    }

    initVolumeMonitoring();

    return () => {
      isMounted = false;
      volumeSubscription?.remove?.();
      clearTimers();
      stopSound();
    };
  }, [clearTimers, stopSound]);

  // Load any previously-saved per-device calibration profile on mount.
  useEffect(() => {
    let isMounted = true;
    (async () => {
      const key = getCalibrationDeviceKey();
      const stored = await loadCalibrationProfile(key);
      if (!isMounted) return;
      setCalibrationDeviceKey(key);
      setCalibrationProfile(stored);
      setCalibrationSavedForDevice(isCalibrationProfileComplete(stored));
    })();
    return () => {
      isMounted = false;
    };
  }, []);

  async function setTargetVolume() {
    if (Platform.OS === 'android') {
      try {
        await VolumeManager.setVolume(TARGET_VOLUME, {
          type: 'music',
          playSound: false,
          showUI: false,
        });
        // Verify with a short retry loop instead of trusting a single
        // read — some Android OEM volume services apply the change
        // asynchronously and the very next read can still show the old
        // value.
        let confirmedVolume = null;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          const confirmed = await VolumeManager.getVolume();
          confirmedVolume = confirmed.volume;
          if (Math.abs(confirmedVolume - TARGET_VOLUME) <= VOLUME_TOLERANCE) break;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        setSystemVolume(confirmedVolume);
        setVolumeBlocked(false);
        if (confirmedVolume == null || Math.abs(confirmedVolume - TARGET_VOLUME) > VOLUME_TOLERANCE) {
          Alert.alert(
            'Volume did not reach maximum automatically',
            'Please also raise the volume fully using the physical side buttons, then continue.',
          );
        }
      } catch (error) {
        Alert.alert(
          'Could not set volume automatically',
          error?.message ??
            'Please raise the volume with the physical side buttons instead.',
        );
      }
      return;
    }

    Alert.alert(
      'Set iPhone volume manually',
      'Apple does not allow apps to change the system volume automatically. Please set your iPhone volume to maximum using the side buttons, then continue.',
    );
    setSystemVolume(TARGET_VOLUME);
    setVolumeBlocked(false);
  }

  function resetAlgorithm(startDb = DEFAULT_START_DB) {
    ascendingWindowsRef.current = {};
    directionRef.current = 'initial';
    hadDescentRef.current = false;
    currentDbRef.current = startDb;
    responseLockedRef.current = false;
    maxMissesRef.current = 0;

    setCurrentDb(startDb);
    setAscendingWindowDisplay([]);
    setDirectionDisplay('initial');
    setHadDescentDisplay(false);
    setHistory([]);
    setTonePlayed(false);
    setLastFeedback(null);
  }

  async function playTone(frequencyHz, dbHL, ear) {
    if (!volumeReady) {
      if (Platform.OS === 'android') {
        Alert.alert(
          'Volume unavailable',
          'System volume is not at maximum yet. Tap "Set volume to maximum" and try again.',
        );
      } else {
        setVolumeBlocked(true);
        Alert.alert(
          'Set iPhone volume to maximum',
          'Set your iPhone volume to maximum before playing a tone.',
        );
      }
      return;
    }

    if (ear !== 'right' && ear !== 'left') {
      Alert.alert('Ear not selected', 'Select a test ear first.');
      return;
    }

    try {
      await cancelTone();
      responseLockedRef.current = false;
      setTonePlayed(false);
      setIsPlaying(true);

      // v4.6 FIX: force playback away from the phone's tiny mono earpiece
      // speaker with a platform-appropriate config. v4.5 tried to attach
      // `interruptionModeAndroid` unconditionally on every platform, which
      // crashed on iOS with "interruptionModeAndroid was set to an
      // invalid value" (that key doesn't exist on iOS, and a try/catch
      // around a simple property read never actually caught anything,
      // since reading a missing constant returns `undefined` rather than
      // throwing). The fix: pick the interruption-mode key per platform,
      // and only attach it if the underlying constant actually resolved
      // to a number.
      const audioModeConfig = {
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      };

      if (
        Platform.OS === 'android' &&
        typeof Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX === 'number'
      ) {
        audioModeConfig.interruptionModeAndroid = Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX;
      } else if (
        Platform.OS === 'ios' &&
        typeof Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX === 'number'
      ) {
        audioModeConfig.interruptionModeIOS = Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX;
      }

      await Audio.setAudioModeAsync(audioModeConfig);

      // System volume is NOT touched here. It was already set to maximum
      // during setup/volume-gate and is only monitored (not moved) from
      // this point on. All loudness control for this specific tone happens
      // through the WAV's digital amplitude, computed in
      // buildStereoWav -> dbHLToAmplitude, using the per-device
      // calibration offset measured in the 'calibrate' phase.

      const resolvedOffset = getOffsetForFrequency(calibrationProfile, frequencyHz);
      const roundedOffset = Math.round(resolvedOffset * 10) / 10;
      const cacheKey = `${Platform.OS}:${frequencyHz}:${dbHL}:${ear}:${roundedOffset}`;
      let base64 = toneCacheRef.current.get(cacheKey);
      if (!base64) {
        base64 = buildStereoWav(frequencyHz, dbHL, ear, calibrationProfile);
        if (toneCacheRef.current.size >= 32) {
          const oldestKey = toneCacheRef.current.keys().next().value;
          toneCacheRef.current.delete(oldestKey);
        }
        toneCacheRef.current.set(cacheKey, base64);
      }

      const token = playbackTokenRef.current + 1;
      playbackTokenRef.current = token;

      const { sound } = await Audio.Sound.createAsync(
        { uri: `data:audio/wav;base64,${base64}` },
        { shouldPlay: true, volume: 1 },
      );

      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (token !== playbackTokenRef.current) return;

        if (!status.isLoaded) {
          if (status.error) {
            setIsPlaying(false);
            setTonePlayed(false);
            Alert.alert('Audio error', status.error);
          }
          return;
        }

        if (status.didJustFinish) {
          sound.setOnPlaybackStatusUpdate(null);
          sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          setIsPlaying(false);
          setTonePlayed(true);
          responseLockedRef.current = false;
        }
      });
    } catch (error) {
      setIsPlaying(false);
      setTonePlayed(false);
      Alert.alert(
        'Unable to play tone',
        error?.message ?? 'Unknown audio error.',
      );
    }
  }

  function showFeedback(heard, delta, note = null) {
    if (feedbackTimerRef.current) clearTimeout(feedbackTimerRef.current);
    setLastFeedback({ heard, delta, note });
    feedbackTimerRef.current = setTimeout(() => {
      setLastFeedback(null);
      feedbackTimerRef.current = null;
    }, 900);
  }

  function addAscendingTrial(db, heard) {
    const previous = ascendingWindowsRef.current[db] ?? [];
    const next = [...previous, heard].slice(-3);
    ascendingWindowsRef.current[db] = next;
    setAscendingWindowDisplay([...next]);
    return next;
  }

  function finishStep(result) {
    if (!currentStep || !currentEar) return;

    const earAtFinish = currentEar;
    const stepAtFinish = currentStep;
    const indexAtFinish = stepIndex;

    const nextThresholds = {
      ...thresholdsRef.current,
      [earAtFinish]: {
        ...thresholdsRef.current[earAtFinish],
        [stepAtFinish.id]: result,
      },
    };

    thresholdsRef.current = nextThresholds;
    setThresholds(nextThresholds);
    setTonePlayed(false);
    responseLockedRef.current = true;
    setThresholdBanner({
      label: stepAtFinish.label,
      frequency: stepAtFinish.freq,
      result,
    });

    transitionTimerRef.current = setTimeout(() => {
      setThresholdBanner(null);
      transitionTimerRef.current = null;

      const nextSteps = getStepsForEar(
        earAtFinish,
        nextThresholds[earAtFinish],
      );
      const nextIndex = indexAtFinish + 1;

      if (nextIndex >= nextSteps.length) {
        if (earAtFinish === 'right') {
          setCurrentEar('left');
          setStepIndex(0);
          setPracticeDb(30);
          setPracticePassed(false);
          resetAlgorithm(DEFAULT_START_DB);
          setPhase('ear_intro');
        } else {
          setPhase('done');
        }
        return;
      }

      const previousResult = result;
      setStepIndex(nextIndex);
      resetAlgorithm(suggestedStartDb(previousResult));
    }, 1300);
  }

  function handleTestResponse(heard) {
    if (
      !tonePlayed ||
      isPlaying ||
      thresholdBanner ||
      volumeBlocked ||
      responseLockedRef.current ||
      !currentStep
    ) {
      return;
    }

    responseLockedRef.current = true;
    setTonePlayed(false);

    const db = currentDbRef.current;
    const arrivedAscending = directionRef.current === 'asc';
    const hadDescent = hadDescentRef.current;
    const validAscending =
      (arrivedAscending && hadDescent) || (db === MIN_DB && hadDescent);

    setHistory((previous) => [
      ...previous,
      {
        db,
        heard,
        validAscending,
        stepId: currentStep.id,
      },
    ]);

    if (!heard && db === MAX_DB) {
      maxMissesRef.current += 1;
      if (maxMissesRef.current >= 2) {
        finishStep(noResponseResult(MAX_DB));
        return;
      }

      directionRef.current = 'asc';
      setDirectionDisplay('asc');
      showFeedback(false, 0, 'Maximum level missed once — repeat for confirmation');
      responseLockedRef.current = false;
      return;
    }

    maxMissesRef.current = 0;

    if (validAscending) {
      const window = addAscendingTrial(db, heard);
      const heardCount = window.filter(Boolean).length;
      // 2 heard responses out of the most recent 3 (or fewer, if 2 of the
      // first 2) already guarantees "at least 2 of the most recent 3", so
      // there is nothing a 3rd trial could change; advance immediately.
      if (heardCount >= 2) {
        let floorLimited = false;
        try {
          floorLimited =
            dbHLToAmplitude(db, currentFrequency, calibrationProfile).dBFS <=
            DBFS_FLOOR_WARNING_THRESHOLD;
        } catch (_) {
          floorLimited = false;
        }
        finishStep(thresholdResult(db, floorLimited));
        return;
      }
    }

    if (heard) {
      const nextDb = Math.max(MIN_DB, db - STEP_DOWN);
      currentDbRef.current = nextDb;
      directionRef.current = 'desc';
      hadDescentRef.current = true;

      setCurrentDb(nextDb);
      setDirectionDisplay('desc');
      setHadDescentDisplay(true);
      showFeedback(true, nextDb - db);
    } else {
      const nextDb = Math.min(MAX_DB, db + STEP_UP);
      currentDbRef.current = nextDb;
      directionRef.current = 'asc';

      setCurrentDb(nextDb);
      setDirectionDisplay('asc');
      showFeedback(false, nextDb - db);
    }

    responseLockedRef.current = false;
  }

  // ─── v4.9: Universal Screening Mode functions ───

  function resetScreeningAlgorithmForNewFrequency() {
    screeningSnrRef.current = SCREENING_START_SNR_DB;
    screeningDirectionRef.current = 'none';
    screeningReversalsRef.current = [];
    screeningTrialCountRef.current = 0;
    setScreeningSnr(SCREENING_START_SNR_DB);
    setScreeningTonePlayed(false);
  }

  function startScreeningFlow() {
    screeningResultsRef.current = { right: {}, left: {} };
    screeningCatchLogRef.current = [];
    setScreeningResults({ right: {}, left: {} });
    setScreeningCatchLog([]);
    setScreeningEar('right');
    setScreeningFreqIndex(0);
    resetScreeningAlgorithmForNewFrequency();
    if (!testStartedAtRef.current) testStartedAtRef.current = new Date();
    setPhase('screening_test');
  }

  async function playScreeningTrial() {
    if (!volumeReady) {
      Alert.alert('Volume unavailable', 'System volume is not at maximum yet.');
      return;
    }
    if (screeningEar !== 'right' && screeningEar !== 'left') return;

    try {
      await cancelTone();
      responseLockedRef.current = false;
      setScreeningTonePlayed(false);
      setIsPlaying(true);

      const audioModeConfig = {
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: false,
      };
      if (
        Platform.OS === 'android' &&
        typeof Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX === 'number'
      ) {
        audioModeConfig.interruptionModeAndroid = Audio.INTERRUPTION_MODE_ANDROID_DO_NOT_MIX;
      } else if (
        Platform.OS === 'ios' &&
        typeof Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX === 'number'
      ) {
        audioModeConfig.interruptionModeIOS = Audio.INTERRUPTION_MODE_IOS_DO_NOT_MIX;
      }
      await Audio.setAudioModeAsync(audioModeConfig);

      // Decide catch-trial status for THIS trial before playing, so both
      // playback and response-handling agree on what was actually played.
      const isCatch =
        screeningTrialCountRef.current > 0 &&
        Math.random() < SCREENING_CATCH_TRIAL_PROBABILITY;
      screeningIsCatchTrialRef.current = isCatch;

      const freq = SCREENING_FREQUENCIES[screeningFreqIndex];
      const base64 = buildToneInNoiseWav(freq, screeningSnrRef.current, screeningEar, isCatch);

      const token = playbackTokenRef.current + 1;
      playbackTokenRef.current = token;

      const { sound } = await Audio.Sound.createAsync(
        { uri: `data:audio/wav;base64,${base64}` },
        { shouldPlay: true, volume: 1 },
      );

      soundRef.current = sound;
      sound.setOnPlaybackStatusUpdate((status) => {
        if (token !== playbackTokenRef.current) return;
        if (!status.isLoaded) {
          if (status.error) {
            setIsPlaying(false);
            setScreeningTonePlayed(false);
            Alert.alert('Audio error', status.error);
          }
          return;
        }
        if (status.didJustFinish) {
          sound.setOnPlaybackStatusUpdate(null);
          sound.unloadAsync().catch(() => {});
          soundRef.current = null;
          setIsPlaying(false);
          setScreeningTonePlayed(true);
          responseLockedRef.current = false;
        }
      });
    } catch (error) {
      setIsPlaying(false);
      setScreeningTonePlayed(false);
      Alert.alert('Unable to play trial', error?.message ?? 'Unknown audio error.');
    }
  }

  function finishScreeningFrequency() {
    const reversals = screeningReversalsRef.current;
    const threshold =
      reversals.length > 0
        ? reversals.slice(-4).reduce((sum, value) => sum + value, 0) /
          Math.min(4, reversals.length)
        : screeningSnrRef.current;
    const roundedThreshold = Math.round(threshold * 10) / 10;

    const freq = SCREENING_FREQUENCIES[screeningFreqIndex];
    screeningResultsRef.current = {
      ...screeningResultsRef.current,
      [screeningEar]: {
        ...screeningResultsRef.current[screeningEar],
        [freq]: roundedThreshold,
      },
    };
    setScreeningResults(screeningResultsRef.current);

    const nextFreqIndex = screeningFreqIndex + 1;
    if (nextFreqIndex < SCREENING_FREQUENCIES.length) {
      setScreeningFreqIndex(nextFreqIndex);
      resetScreeningAlgorithmForNewFrequency();
      return;
    }

    if (screeningEar === 'right') {
      setScreeningEar('left');
      setScreeningFreqIndex(0);
      resetScreeningAlgorithmForNewFrequency();
      setPhase('screening_ear_intro');
      return;
    }

    setPhase('screening_done');
  }

  function handleScreeningResponse(heard) {
    if (!screeningTonePlayed || isPlaying || responseLockedRef.current) return;
    responseLockedRef.current = true;
    setScreeningTonePlayed(false);

    if (screeningIsCatchTrialRef.current) {
      screeningCatchLogRef.current = [...screeningCatchLogRef.current, { heard }];
      setScreeningCatchLog(screeningCatchLogRef.current);
      responseLockedRef.current = false;
      return;
    }

    const currentSnr = screeningSnrRef.current;
    const newDirection = heard ? 'down' : 'up'; // heard -> make it harder (lower SNR)
    if (
      screeningDirectionRef.current !== 'none' &&
      screeningDirectionRef.current !== newDirection
    ) {
      screeningReversalsRef.current = [...screeningReversalsRef.current, currentSnr];
    }
    screeningDirectionRef.current = newDirection;

    const rawNext = heard ? currentSnr - SCREENING_STEP_DB : currentSnr + SCREENING_STEP_DB;
    const nextSnr = Math.max(SCREENING_MIN_SNR_DB, Math.min(SCREENING_MAX_SNR_DB, rawNext));
    screeningSnrRef.current = nextSnr;
    setScreeningSnr(nextSnr);

    screeningTrialCountRef.current += 1;
    responseLockedRef.current = false;

    if (screeningTrialCountRef.current >= SCREENING_TRIALS_PER_FREQUENCY) {
      finishScreeningFrequency();
    }
  }

  function resetAll() {
    clearTimers();
    cancelTone();
    thresholdsRef.current = { right: {}, left: {} };
    toneCacheRef.current.clear();
    testStartedAtRef.current = null;
    screeningResultsRef.current = { right: {}, left: {} };
    screeningCatchLogRef.current = [];

    setParticipantName('');
    setParticipantAge('');
    setParticipantSex(null);
    setReferredBy('');
    setChiefComplaint('');
    setTestId('');
    setHeadphoneDescription('');
    setPhoneModel('');
    setConnectionType('wired');
    setTestMode(null);
    setDeviceProfile(null);
    setScreeningEar(null);
    setScreeningFreqIndex(0);
    setScreeningResults({ right: {}, left: {} });
    setScreeningCatchLog([]);
    setHeadphonesConfirmed(false);
    setQuietRoomConfirmed(false);
    setPhase('setup');
    setCurrentEar(null);
    setStepIndex(0);
    setThresholds({ right: {}, left: {} });
    setPracticeDb(30);
    setPracticePassed(false);
    setChannelCheck({ right: false, left: false });
    setChannelCheckEar(null);
    setThresholdBanner(null);
    setVolumeBlocked(false);
    resetAlgorithm(DEFAULT_START_DB);
  }

  // v4.6: calibration is now a hard gate. Testing cannot begin (and the
  // practice tone cannot be treated as meaningful) until a calibration
  // offset has actually been saved for this device. Skipping calibration
  // used to silently leave calibrationOffsetDb at 0, which — given the
  // placeholder 105 dB @ 0 dBFS base table — renders most requested
  // levels around -60 dBFS: effectively inaudible, producing exactly the
  // "nothing until ~70 dB" symptom.
  function beginTestingCurrentEar() {
    if (!calibrationSavedForDevice) {
      Alert.alert(
        'Calibration required',
        'This device has not been calibrated yet, so loudness levels are not meaningful. Please run device calibration first.',
      );
      goToCalibration('familiarize');
      return;
    }
    const startDb = Math.max(DEFAULT_START_DB, Math.min(MAX_DB, practiceDb));
    setStepIndex(0);
    resetAlgorithm(startDb);
    setPhase('testing');
    if (!testStartedAtRef.current) testStartedAtRef.current = new Date();
  }

  function handlePracticeResponse(heard) {
    if (!tonePlayed || isPlaying) return;
    setTonePlayed(false);

    if (heard) {
      setPracticePassed(true);
      return;
    }

    const next = Math.min(70, practiceDb + 10);
    setPracticeDb(next);
    if (next === 70) {
      Alert.alert(
        'Practice tone not heard',
        'If you truly hear nothing even at 70 dB HL with headphones on and volume at maximum, run the calibration wizard again rather than continuing — the loudness mapping for this device may be off. You can still continue if you prefer, but results may show no response at several frequencies.',
      );
    }
  }

  function beginRightEar() {
    // v4.6: same hard gate as beginTestingCurrentEar, applied one screen
    // earlier so a tester can't even reach the practice tone with an
    // unconfirmed calibration.
    if (!calibrationSavedForDevice) {
      Alert.alert(
        'Calibration required',
        'This device has not been calibrated yet. Please run device calibration before starting the hearing test.',
      );
      goToCalibration('channel_check');
      return;
    }
    setCurrentEar('right');
    setPracticeDb(30);
    setPracticePassed(false);
    setPhase('ear_intro');
  }

  // v4.9: called from the setup screen's continue button. Looks up
  // DEVICE_PROFILES for this exact phone+headphone+connection
  // combination. A validated match unlocks the (existing) calibrated
  // pure-tone dB HL flow; anything else — which today means EVERY
  // combination, since DEVICE_PROFILES ships empty — routes to Universal
  // Screening Mode, which needs no subjective calibration at all.
  function proceedFromSetup() {
    const key = getDeviceProfileKey({
      phoneModel,
      headphoneModel: headphoneDescription,
      connectionType,
    });
    const profile = lookupDeviceProfile(key);
    setDeviceProfile(profile);

    if (profile) {
      setTestMode('calibrated_pure_tone');
      goToCalibration('channel_check');
    } else {
      setTestMode('universal_screening');
      cancelTone();
      setPhase('channel_check');
    }
  }

  // Navigate to the calibration wizard from anywhere, remembering where to
  // return to afterwards. Always restarts from the first calibration
  // frequency — existing saved values (if any) are kept as the starting
  // point for each frequency rather than reset to 0.
  function goToCalibration(returnPhase) {
    calibrationReturnPhaseRef.current = returnPhase;
    calibrationLastDirectionRef.current = null;
    setCalibrationWizardIndex(0);
    setCalibrationStepDb(CALIBRATION_COARSE_STEP_DB);
    setCalibrationLimitReached({});
    cancelTone();
    setPhase('calibrate');
  }

  // Adaptive step size. Direction is inferred from the sign of deltaDb
  // ('louder' taps are positive, 'quieter' taps are negative). The first
  // time the tester reverses direction relative to their previous tap, we
  // treat that as "we've bracketed the true threshold" and drop to the
  // fine step for the rest of this frequency — same idea as the
  // ascending/descending logic already used in the main test algorithm.
  // v4.7: adjusts only the offset for the CURRENT wizard frequency, since
  // the profile now holds one value per calibration frequency.
  function adjustCalibration(deltaDb) {
    cancelTone();

    const direction = deltaDb > 0 ? 'louder' : 'quieter';
    const previousDirection = calibrationLastDirectionRef.current;
    if (previousDirection && previousDirection !== direction) {
      setCalibrationStepDb(CALIBRATION_FINE_STEP_DB);
    }
    calibrationLastDirectionRef.current = direction;

    const currentCalFreq = CALIBRATION_FREQUENCIES[calibrationWizardIndex];
    setCalibrationProfile((previous) => {
      const previousValue = previous[currentCalFreq] ?? 0;
      const rawNext = previousValue + deltaDb;
      const next = Math.max(
        CALIBRATION_MIN_OFFSET_DB,
        Math.min(CALIBRATION_MAX_OFFSET_DB, rawNext),
      );

      // v4.8: if the tester is still pushing "louder" (or "quieter") after
      // we've already clamped to the cap, that means the tone is still
      // not faint-but-audible at the maximum correction this app allows —
      // a real signal worth surfacing, not silently discarding.
      const hitLimit = rawNext !== next;
      setCalibrationLimitReached((prevLimits) => ({
        ...prevLimits,
        [currentCalFreq]: hitLimit,
      }));

      return { ...previous, [currentCalFreq]: Math.round(next * 10) / 10 };
    });
  }

  // v4.7: advances to the next calibration frequency, or — on the last
  // frequency — persists the full multi-point profile and returns to
  // wherever the wizard was launched from.
  async function confirmCalibrationStep() {
    await cancelTone();

    const currentCalFreq = CALIBRATION_FREQUENCIES[calibrationWizardIndex];
    const isLastCalFreq = calibrationWizardIndex === CALIBRATION_FREQUENCIES.length - 1;

    // v4.8: if this frequency hit the offset cap, warn explicitly instead
    // of silently treating the clamped value as a valid device
    // correction. A real test on a person with clinically-confirmed
    // moderate hearing loss needed far more than this app's old cap to
    // hear the reference tone at all — and the app absorbed that entire
    // loss into "calibration," reporting her as normal. Needing more
    // correction than a phone/headphone pair could plausibly require is a
    // sign worth surfacing to the tester, not hiding.
    if (calibrationLimitReached[currentCalFreq]) {
      Alert.alert(
        'Still not comfortable at maximum correction',
        `Even at this app's maximum allowed adjustment, the ${formatFrequency(currentCalFreq)} tone was not faint-but-audible for you. This is more likely to reflect your own hearing sensitivity at this frequency than a quiet device — this app cannot tell the difference, so please treat any "normal" result with caution and consider a professional hearing assessment regardless of what this screening shows.`,
      );
    }

    if (!isLastCalFreq) {
      calibrationLastDirectionRef.current = null;
      setCalibrationStepDb(CALIBRATION_COARSE_STEP_DB);
      setCalibrationWizardIndex((index) => index + 1);
      return;
    }

    const key = calibrationDeviceKey ?? getCalibrationDeviceKey();
    await saveCalibrationProfile(key, calibrationProfile);
    setCalibrationDeviceKey(key);
    setCalibrationSavedForDevice(isCalibrationProfileComplete(calibrationProfile));
    setPhase(calibrationReturnPhaseRef.current || 'channel_check');
  }

  function buildTextReport() {
    const date = new Date().toLocaleString('en-IN');
    const volumeLine = `System volume: held at maximum (${Math.round((systemVolume ?? TARGET_VOLUME) * 100)}%); loudness per frequency is controlled entirely by digital gain (see per-frequency volume below for exact levels used)`;
    const rightPta = computeFourFrequencyPTA(thresholds.right);
    const leftPta = computeFourFrequencyPTA(thresholds.left);

    const lines = [
      'HearSmart Hearing-Screening Report',
      `Date: ${date}`,
      `Participant: ${participantName || 'Not provided'}`,
      `Age / Sex: ${participantAge || 'Not provided'} / ${participantSex || 'Not provided'}`,
      `Referred by: ${referredBy || 'Not provided'}`,
      `Chief complaint: ${chiefComplaint || 'Not provided'}`,
      `Test ID: ${testId || 'Not provided'}`,
      `Headphones: ${headphoneDescription || 'Not provided'}`,
      `Platform: ${Platform.OS}`,
      volumeLine,
      `Device calibration profile: ${formatCalibrationProfile(calibrationProfile)}`,
      'Calibration: Prototype generic profile; not physically calibrated',
      '',
      `Provisional diagnosis: ${buildProvisionalDiagnosis(rightPta, leftPta)}`,
      '',
    ];

    for (const ear of ['right', 'left']) {
      const earResults = thresholds[ear];
      const steps = getStepsForEar(ear, earResults);
      lines.push(`${ear.toUpperCase()} EAR`);
      for (const item of steps) {
        const result = earResults[item.id];
        if (result) {
          const volLabel = volumeLabelForResult(item.freq, result, calibrationProfile);
          lines.push(
            `${formatFrequency(item.freq)} ${item.label}: ${formatResult(result)} estimated HL` +
              (volLabel ? ` — ${volLabel}` : ''),
          );
        }
      }
      const pta = computeFourFrequencyPTA(earResults);
      lines.push(`Four-frequency PTA: ${pta == null ? 'Not available' : `${pta} dB estimated HL`}`);
      lines.push('');
    }

    lines.push('Type of loss (conductive vs. sensorineural) not determined — bone conduction not performed.');
    lines.push('Screening prototype only. Confirm abnormal findings with a licensed audiologist.');
    return lines.join('\n');
  }

  async function exportPdf() {
    if (exporting) return;
    setExporting(true);

    try {
      const reportTime = new Date();
      const started = testStartedAtRef.current;
      const rightPta = computeFourFrequencyPTA(thresholds.right);
      const leftPta = computeFourFrequencyPTA(thresholds.left);
      const rightClass = classify(rightPta);
      const leftClass = classify(leftPta);
      const rightSvg = buildEarAudiogramSvg('right', thresholds.right);
      const leftSvg = buildEarAudiogramSvg('left', thresholds.left);
      const provisionalDiagnosis = buildProvisionalDiagnosis(rightPta, leftPta);

      const buildEarRows = (ear) => {
        const earResults = thresholds[ear];
        return getStepsForEar(ear, earResults)
          .filter((item) => earResults[item.id])
          .map((item) => {
            const result = earResults[item.id];
            const interpolation = INTERPOLATED_FREQUENCIES.has(item.freq) ? ' *' : '';
            const note = item.id.includes('retest') || item.id.includes('recheck') ? ' (retest)' : '';
            const volLabel = volumeLabelForResult(item.freq, result, calibrationProfile);
            return `
              <tr>
                <td>${formatFrequency(item.freq)}${interpolation}${note}</td>
                <td>${escapeHtml(formatResult(result))} estimated HL</td>
                <td>${volLabel ? escapeHtml(volLabel) : '—'}</td>
              </tr>
            `;
          })
          .join('');
      };

      const tableHeader = `<tr><th>Frequency</th><th>Result</th><th>Digital gain used</th></tr>`;

      const reliability = is1000RetestReliable(thresholds.right);
      const reliabilityHtml =
        reliability == null
          ? ''
          : reliability
            ? '<p class="good">✓ Right-ear 1 kHz retest is within 5 dB.</p>'
            : '<p class="warn">⚠ Right-ear 1 kHz retest differs by more than 5 dB. The lower 1 kHz value was used and 2 kHz was rechecked.</p>';

      const volumeMetaHtml = `<div><strong>Volume control:</strong> System volume held at maximum (${Math.round((systemVolume ?? TARGET_VOLUME) * 100)}%); loudness per frequency controlled entirely by digital gain, using a per-device calibration profile measured across ${CALIBRATION_FREQUENCIES.length} reference points on this phone/headphone pair (${escapeHtml(formatCalibrationProfile(calibrationProfile))}) — intermediate frequencies are interpolated between these points (see per-frequency table below for exact levels used)</div>`;

      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <style>
              @page { margin: 28px; }
              body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #172033; margin: 0; font-size: 12px; }
              h1 { margin: 0; font-size: 28px; color: #0a1628; }
              h2 { font-size: 15px; margin: 0 0 10px; color: #0a1628; }
              .sub { color: #0d6e8a; margin: 4px 0 16px; }
              .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 7px 18px; background: #f4f7fb; padding: 12px; border-radius: 10px; margin-bottom: 14px; }
              .section { border: 1px solid #dce3ec; border-radius: 10px; padding: 14px; margin-bottom: 14px; break-inside: avoid; }
              .panels { display: flex; gap: 14px; justify-content: center; flex-wrap: wrap; }
              .legend { display: flex; gap: 18px; margin: 8px 0 2px; justify-content: center; }
              .right { color: ${RIGHT_COLOR}; font-weight: 700; }
              .left { color: ${LEFT_COLOR}; font-weight: 700; }
              .pta { font-size: 26px; font-weight: 800; margin: 2px 0; }
              .classification { margin: 3px 0 8px; font-weight: 700; }
              table { width: 100%; border-collapse: collapse; }
              th, td { text-align: left; padding: 7px; border-bottom: 1px solid #e5eaf0; }
              th { color: #64748b; font-size: 10px; text-transform: uppercase; }
              .good { color: #047857; }
              .warn { color: #b45309; }
              .note { font-size: 10px; color: #64748b; line-height: 1.5; }
              .diagnosis { font-size: 13px; font-weight: 700; color: #0a1628; background: #eef4fb; border-radius: 8px; padding: 10px 12px; }
              .scope-table td, .scope-table th { font-size: 11px; }
              .scope-na { color: #94a3b8; }
              .disclaimer { border: 1px solid #f59e0b; background: #fffbeb; border-radius: 10px; padding: 12px; font-size: 10px; line-height: 1.55; }
            </style>
          </head>
          <body>
            <h1>HearSmart</h1>
            <div class="sub">Pure-tone hearing-screening research prototype · Report v${APP_VERSION}</div>

            <div class="meta">
              <div><strong>Participant:</strong> ${escapeHtml(participantName || 'Not provided')}</div>
              <div><strong>Age / Sex:</strong> ${escapeHtml(participantAge || 'Not provided')} / ${escapeHtml(participantSex || 'Not provided')}</div>
              <div><strong>Referred by:</strong> ${escapeHtml(referredBy || 'Not provided')}</div>
              <div><strong>Chief complaint:</strong> ${escapeHtml(chiefComplaint || 'Not provided')}</div>
              <div><strong>Test ID:</strong> ${escapeHtml(testId || 'Not provided')}</div>
              <div><strong>Report time:</strong> ${escapeHtml(reportTime.toLocaleString('en-IN'))}</div>
              <div><strong>Test started:</strong> ${escapeHtml(started ? started.toLocaleString('en-IN') : 'Not recorded')}</div>
              <div><strong>Device:</strong> ${escapeHtml(`${Device.modelName ?? 'Unknown'} · ${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`)}</div>
              <div><strong>Headphones:</strong> ${escapeHtml(headphoneDescription || 'Not provided')}</div>
              ${volumeMetaHtml}
              <div><strong>Calibration:</strong> Prototype generic profile; not physically calibrated</div>
            </div>

            <div class="section">
              <h2>Pure Tone Audiogram — air conduction, unmasked</h2>
              <div class="panels">
                ${rightSvg}
                ${leftSvg}
              </div>
              <div class="legend">
                <span class="right">O = right ear (air, unmasked)</span>
                <span class="left">X = left ear (air, unmasked)</span>
                <span>↓ = no response at prototype ceiling</span>
              </div>
            </div>

            <div class="section">
              <h2>PTA / SRT / SDS / SISI / TDT</h2>
              <table class="scope-table">
                <tr><th></th><th>PTA</th><th>SRT</th><th>SDS</th><th>SISI</th><th>TDT</th></tr>
                <tr>
                  <td class="right">Right</td>
                  <td>${rightPta == null ? '—' : `${rightPta} dB HL`}</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                </tr>
                <tr>
                  <td class="left">Left</td>
                  <td>${leftPta == null ? '—' : `${leftPta} dB HL`}</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                  <td class="scope-na">not assessed</td>
                </tr>
              </table>
              <p class="note">SRT, SDS, SISI and TDT require speech-audiometry and suprathreshold equipment this app does not implement, and are marked "not assessed" rather than estimated.</p>
            </div>

            <div class="section">
              <h2>Provisional diagnosis</h2>
              ${
                hasCalibrationLimitWarning(calibrationLimitReached)
                  ? '<div class="disclaimer" style="margin-bottom:10px;"><strong>⚠ Calibration reached its limit:</strong> during setup, at least one frequency was still not comfortably audible even at the maximum correction this app allows. This is more likely to reflect real reduced sensitivity at that frequency than a quiet device — this app cannot distinguish the two. Treat any "normal" finding below with caution and consider a professional hearing assessment regardless of what this screening shows.</div>'
                  : ''
              }
              <div class="diagnosis">${escapeHtml(provisionalDiagnosis)}</div>
              <p class="note">TFT (Rinne / Weber / ABC): not performed — this app is an air-conduction screening tool only and does not include bone-conduction testing, so laterality/type-of-loss tuning-fork or bone-conduction findings cannot be produced.</p>
            </div>

            <div class="section">
              <h2 class="right">Right ear detail</h2>
              <div class="pta">${rightPta == null ? 'PTA unavailable' : `${rightPta} dB estimated HL`}</div>
              ${rightClass ? `<div class="classification" style="color:${rightClass.color}">${escapeHtml(rightClass.label)}</div><p>${escapeHtml(rightClass.recommendation)}</p>` : ''}
              ${reliabilityHtml}
              <table>
                ${tableHeader}
                ${buildEarRows('right')}
              </table>
            </div>

            <div class="section">
              <h2 class="left">Left ear detail</h2>
              <div class="pta">${leftPta == null ? 'PTA unavailable' : `${leftPta} dB estimated HL`}</div>
              ${leftClass ? `<div class="classification" style="color:${leftClass.color}">${escapeHtml(leftClass.label)}</div><p>${escapeHtml(leftClass.recommendation)}</p>` : ''}
              <table>
                ${tableHeader}
                ${buildEarRows('left')}
              </table>
            </div>

            <div class="section">
              <h2>Recommendation</h2>
              <p>${escapeHtml(
                (rightClass && rightClass.shortLabel !== 'Normal') || (leftClass && leftClass.shortLabel !== 'Normal')
                  ? `Consult ${referredBy ? escapeHtml(referredBy) : 'an ENT / licensed audiologist'} for confirmatory diagnostic audiometry (including bone conduction) and follow-up.`
                  : 'Findings are within the normal screening range on this prototype. Repeat screening periodically, or sooner if symptoms develop.',
              )}</p>
            </div>

            <p class="note">* 3 kHz and 6 kHz use interpolated reference values. Four-frequency PTA uses 500, accepted 1000, 2000, and 4000 Hz when all four measured thresholds are available. "Digital gain used" shows the dBFS attenuation and target SPL used for that specific frequency (recomputed from the accepted dB HL and this device's calibration offset, matching exactly what was played).</p>

            <div class="disclaimer">
              <strong>Important limitation:</strong> This application is an uncalibrated air-conduction screening prototype, not a medical device or clinical audiometer. The SPL-to-HL calculation uses reference values plus a prototype digital-output profile and a per-device calibration offset measured by ear (not with a sound-level meter), and must be re-checked per device. Actual SPL depends on the exact phone, operating system, system volume, headphone model, fit, coupling, and acoustic environment. The test cannot distinguish conductive from sensorineural hearing loss and does not implement clinical masking, bone conduction, Rinne, Weber, or speech audiometry. Confirm any abnormal, asymmetric, sudden, or concerning result with a licensed audiologist or ENT clinician.
            </div>
          </body>
        </html>
      `;

      const { uri } = await Print.printToFileAsync({ html, base64: false });

      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          dialogTitle: 'Share HearSmart PDF report',
          UTI: 'com.adobe.pdf',
        });
      } else {
        await Share.share({
          title: 'HearSmart Hearing Report',
          message: buildTextReport(),
        });
      }
    } catch (error) {
      Alert.alert(
        'Report export failed',
        error?.message ?? 'Unable to generate the PDF report.',
      );
    } finally {
      setExporting(false);
    }
  }

  if (phase === 'setup') {
    const canContinue =
      volumeReady &&
      headphonesConfirmed &&
      quietRoomConfirmed &&
      phoneModel.trim().length > 0 &&
      headphoneDescription.trim().length > 0;

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.appName}>HearSmart</Text>
          <Text style={styles.appSub}>Hearing-screening research prototype</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Test information</Text>
            <TextInput
              value={participantName}
              onChangeText={setParticipantName}
              placeholder="Participant name (optional)"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <TextInput
              value={participantAge}
              onChangeText={setParticipantAge}
              placeholder="Age (optional)"
              placeholderTextColor="#64748B"
              keyboardType="number-pad"
              style={styles.input}
            />
            <View style={styles.sexRow}>
              {['female', 'male', 'other'].map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.sexPill, participantSex === option && styles.sexPillActive]}
                  onPress={() => setParticipantSex(option)}
                >
                  <Text
                    style={[styles.sexPillText, participantSex === option && styles.sexPillTextActive]}
                  >
                    {option.charAt(0).toUpperCase() + option.slice(1)}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput
              value={referredBy}
              onChangeText={setReferredBy}
              placeholder="Referred by / clinician (optional)"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <TextInput
              value={chiefComplaint}
              onChangeText={setChiefComplaint}
              placeholder="Chief complaint (optional)"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <TextInput
              value={testId}
              onChangeText={setTestId}
              placeholder="Test ID (optional)"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <TextInput
              value={phoneModel}
              onChangeText={setPhoneModel}
              placeholder="Phone model (e.g. iPhone 14 Pro Max)"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <TextInput
              value={headphoneDescription}
              onChangeText={setHeadphoneDescription}
              placeholder="Headphone/earphone model"
              placeholderTextColor="#64748B"
              style={styles.input}
            />
            <View style={styles.sexRow}>
              {['wired', 'bluetooth'].map((option) => (
                <TouchableOpacity
                  key={option}
                  style={[styles.sexPill, connectionType === option && styles.sexPillActive]}
                  onPress={() => setConnectionType(option)}
                >
                  <Text style={[styles.sexPillText, connectionType === option && styles.sexPillTextActive]}>
                    {option === 'wired' ? 'Wired' : 'Bluetooth'}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
            {isLikelyWirelessHeadphone(headphoneDescription) ? (
              <View style={[styles.card, { borderColor: '#B45309', borderWidth: 1.5, marginBottom: 0, marginTop: 4 }]}>
                <Text style={[styles.cardTitle, { color: '#FDE68A', fontSize: 14 }]}>
                  Wireless / Bluetooth headphones detected
                </Text>
                <Text style={styles.cardBody}>
                  Bluetooth earbuds (including AirPods) commonly apply adaptive EQ or dynamic
                  volume processing that isn't a flat gain, which this app's single-point
                  calibration cannot fully correct for. This can make faint tones behave
                  unpredictably and push thresholds higher than your true hearing sensitivity.
                  For the most trustworthy result, use simple wired headphones or earphones
                  with no active processing. You can still continue with wireless, but treat
                  results — especially anything above "Normal" — with caution.
                </Text>
              </View>
            ) : null}
          </View>

          <VolumeGate systemVolume={systemVolume} volumeLoading={volumeLoading} volumeReady={volumeReady} onSetTargetVolume={setTargetVolume} />

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Before you begin</Text>
            {[
              'Use headphones or earphones; keep their position unchanged.',
              'Sit in the quietest room available and close doors and windows.',
              'System volume is held at maximum; loudness for each frequency is controlled digitally.',
              'You will calibrate loudness once for this exact phone + headphone pair before testing.',
              'Respond whenever you detect a tone, even if it is very faint.',
              'The app routes right and left channels separately.',
              'Results are estimated dB HL and are not clinically calibrated.',
            ].map((item, index) => (
              <View style={styles.checkRow} key={item}>
                <View style={styles.checkCircle}>
                  <Text style={styles.checkNumber}>{index + 1}</Text>
                </View>
                <Text style={styles.checkText}>{item}</Text>
              </View>
            ))}

            <TouchableOpacity
              style={styles.confirmRow}
              onPress={() => setHeadphonesConfirmed((value) => !value)}
            >
              <View style={[styles.checkbox, headphonesConfirmed && styles.checkboxChecked]}>
                <Text style={styles.checkboxText}>{headphonesConfirmed ? '✓' : ''}</Text>
              </View>
              <Text style={styles.confirmText}>I am wearing headphones securely.</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.confirmRow}
              onPress={() => setQuietRoomConfirmed((value) => !value)}
            >
              <View style={[styles.checkbox, quietRoomConfirmed && styles.checkboxChecked]}>
                <Text style={styles.checkboxText}>{quietRoomConfirmed ? '✓' : ''}</Text>
              </View>
              <Text style={styles.confirmText}>
                I am in a quiet room — no TV, fan, traffic, or people talking nearby. (Ambient
                noise is the single biggest cause of falsely elevated results, especially at
                low frequencies.)
              </Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, !canContinue && styles.disabledButton]}
            disabled={!canContinue}
            onPress={proceedFromSetup}
          >
            <Text style={styles.primaryButtonText}>
              {(() => {
                const key = getDeviceProfileKey({
                  phoneModel,
                  headphoneModel: headphoneDescription,
                  connectionType,
                });
                return lookupDeviceProfile(key)
                  ? 'Continue to device calibration'
                  : 'Continue to hearing screening';
              })()}
            </Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'calibrate') {
    const currentCalFreq = CALIBRATION_FREQUENCIES[calibrationWizardIndex];
    const isLastCalFreq = calibrationWizardIndex === CALIBRATION_FREQUENCIES.length - 1;
    const currentCalOffset = calibrationProfile[currentCalFreq] ?? 0;

    let dbfsInfo = null;
    try {
      dbfsInfo = dbHLToAmplitude(CALIBRATION_REFERENCE_DB_HL, currentCalFreq, calibrationProfile);
    } catch (_) {
      dbfsInfo = null;
    }

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Device calibration</Text>
          <Text style={styles.appSub}>
            Step {calibrationWizardIndex + 1} of {CALIBRATION_FREQUENCIES.length} · one-time setup for this phone + headphone pair
          </Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Why this matters</Text>
            <Text style={styles.cardBody}>
              Real headphones and phone speakers don't reproduce every frequency at the same
              loudness — low and high tones are often quieter or louder than the mid-range for
              the same digital signal. Calibrating at only one frequency leaves the others
              wrong, which is why this wizard checks {CALIBRATION_FREQUENCIES.length} points
              across the range instead of just one. All {CALIBRATION_FREQUENCIES.length} must
              be completed and saved before testing can begin.
              {calibrationSavedForDevice
                ? ' A saved calibration for this device was found and pre-loaded below — keep it, or adjust and re-save.'
                : ' No saved calibration was found for this device yet.'}
            </Text>
          </View>

          <View style={styles.progressTrack}>
            <View
              style={[
                styles.progressFill,
                {
                  width: `${Math.round(((calibrationWizardIndex + 1) / CALIBRATION_FREQUENCIES.length) * 100)}%`,
                  backgroundColor: ACCENT,
                },
              ]}
            />
          </View>

          <View style={styles.dbCard}>
            <Text style={styles.levelLabel}>Reference tone</Text>
            <Text style={styles.dbNumber}>{CALIBRATION_REFERENCE_DB_HL}</Text>
            <Text style={styles.dbUnit}>target dB HL · {formatFrequency(currentCalFreq)} · right ear</Text>
            <Text style={styles.smallNote}>
              Calibration offset at {formatFrequency(currentCalFreq)}: {currentCalOffset > 0 ? '+' : ''}
              {currentCalOffset} dB
              {dbfsInfo
                ? `  ·  ${dbfsInfo.dBFS.toFixed(1)} dBFS${dbfsInfo.clipped ? ' (at device max — cannot go louder)' : ''}`
                : ''}
            </Text>
            <Text style={styles.smallNote}>
              Adjustment step: {calibrationStepDb} dB{calibrationStepDb === CALIBRATION_COARSE_STEP_DB ? ' (coarse)' : ' (fine)'}
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.playButton, isPlaying && styles.stopButton]}
            onPress={
              isPlaying
                ? cancelTone
                : () => playTone(currentCalFreq, CALIBRATION_REFERENCE_DB_HL, 'right')
            }
          >
            <Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : 'Play calibration tone'}</Text>
          </TouchableOpacity>

          <View style={styles.responseRow}>
            <TouchableOpacity
              style={styles.notHeardButton}
              onPress={() => adjustCalibration(calibrationStepDb)}
            >
              <Text style={styles.notHeardButtonText}>Can't hear it — louder</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.heardButton}
              onPress={() => adjustCalibration(-calibrationStepDb)}
            >
              <Text style={styles.heardButtonText}>Too loud — quieter</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.primaryButton, { backgroundColor: ACCENT }]} onPress={confirmCalibrationStep}>
            <Text style={styles.primaryButtonText}>
              {isLastCalFreq
                ? "Faint but clearly audible — save & finish"
                : `Faint but clearly audible — next: ${formatFrequency(CALIBRATION_FREQUENCIES[calibrationWizardIndex + 1])}`}
            </Text>
          </TouchableOpacity>

          <Text style={styles.smallNote}>
            Tap "Play calibration tone" after every adjustment, and repeat louder/quieter until the tone is faint but clearly audible — not silent, not comfortable/loud. Steps start large (6 dB) and automatically shrink to 2 dB once you reverse direction, so it should take only a handful of taps per frequency. If it is silent even at the device max shown above, verify headphones are plugged in/paired and that system volume is really at maximum before adjusting further.
          </Text>
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  if (phase === 'channel_check') {
    const bothConfirmed = channelCheck.right && channelCheck.left;

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Channel check</Text>
          <Text style={styles.appSub}>Confirm that stereo routing is correct</Text>
          <VolumeGate systemVolume={systemVolume} volumeLoading={volumeLoading} volumeReady={volumeReady} onSetTargetVolume={setTargetVolume} />

          {testMode === 'calibrated_pure_tone' && !calibrationSavedForDevice ? (
            <View style={[styles.card, { borderColor: '#B45309', borderWidth: 1.5 }]}>
              <Text style={[styles.cardTitle, { color: '#FDE68A' }]}>Calibration not confirmed</Text>
              <Text style={styles.cardBody}>
                Testing is disabled until device calibration is completed and saved. Loudness levels are not meaningful without it.
              </Text>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => goToCalibration('channel_check')}>
                <Text style={styles.secondaryButtonText}>Run device calibration</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {testMode === 'universal_screening' ? (
            <View style={[styles.card, { borderColor: '#0D6E8A', borderWidth: 1.5 }]}>
              <Text style={[styles.cardTitle, { color: '#7DD3FC' }]}>Universal Screening Mode</Text>
              <Text style={styles.cardBody}>
                No validated acoustic profile exists for this phone + headphone combination, so
                this run will use hearing screening (tone-in-noise, PASS/REFER) instead of a
                pure-tone dB HL test. No calibration step is needed for this mode.
              </Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Right channel</Text>
            <Text style={styles.cardBody}>The next tone should be heard only in the right ear.</Text>
            <TouchableOpacity
              style={[styles.channelButton, { borderColor: RIGHT_COLOR }]}
              onPress={() => {
                setChannelCheckEar('right');
                playTone(1000, 40, 'right');
              }}
            >
              <Text style={[styles.channelButtonText, { color: RIGHT_COLOR }]}>Play right-channel tone</Text>
            </TouchableOpacity>
            {tonePlayed && channelCheckEar === 'right' ? (
              <View style={styles.responseRow}>
                <TouchableOpacity
                  style={styles.heardButton}
                  onPress={() => {
                    setTonePlayed(false);
                    setChannelCheck((value) => ({ ...value, right: true }));
                  }}
                >
                  <Text style={styles.heardButtonText}>✓ Heard in right</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.notHeardButton}
                  onPress={() => {
                    setTonePlayed(false);
                    setChannelCheck((value) => ({ ...value, right: false }));
                    Alert.alert('Check failed', 'Verify headphone orientation and try again. If you heard nothing at all, re-run device calibration.');
                  }}
                >
                  <Text style={styles.notHeardButtonText}>Wrong / not heard</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <Text style={{ color: channelCheck.right ? '#059669' : '#64748B', marginTop: 8 }}>
              {channelCheck.right ? '✓ Right channel confirmed' : 'Not confirmed'}
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Left channel</Text>
            <Text style={styles.cardBody}>The next tone should be heard only in the left ear.</Text>
            <TouchableOpacity
              style={[styles.channelButton, { borderColor: LEFT_COLOR }]}
              onPress={() => {
                setChannelCheckEar('left');
                playTone(1000, 40, 'left');
              }}
            >
              <Text style={[styles.channelButtonText, { color: LEFT_COLOR }]}>Play left-channel tone</Text>
            </TouchableOpacity>
            {tonePlayed && channelCheckEar === 'left' ? (
              <View style={styles.responseRow}>
                <TouchableOpacity
                  style={styles.heardButton}
                  onPress={() => {
                    setTonePlayed(false);
                    setChannelCheck((value) => ({ ...value, left: true }));
                  }}
                >
                  <Text style={styles.heardButtonText}>✓ Heard in left</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.notHeardButton}
                  onPress={() => {
                    setTonePlayed(false);
                    setChannelCheck((value) => ({ ...value, left: false }));
                    Alert.alert('Check failed', 'Verify headphone orientation and try again. If you heard nothing at all, re-run device calibration.');
                  }}
                >
                  <Text style={styles.notHeardButtonText}>Wrong / not heard</Text>
                </TouchableOpacity>
              </View>
            ) : null}
            <Text style={{ color: channelCheck.left ? '#059669' : '#64748B', marginTop: 8 }}>
              {channelCheck.left ? '✓ Left channel confirmed' : 'Not confirmed'}
            </Text>
          </View>

          {testMode === 'calibrated_pure_tone' ? (
            <TouchableOpacity style={styles.secondaryButton} onPress={() => goToCalibration('channel_check')}>
              <Text style={styles.secondaryButtonText}>Re-run device calibration</Text>
            </TouchableOpacity>
          ) : null}

          <TouchableOpacity
            style={[
              styles.primaryButton,
              (!bothConfirmed || (testMode === 'calibrated_pure_tone' && !calibrationSavedForDevice)) &&
                styles.disabledButton,
            ]}
            disabled={!bothConfirmed || (testMode === 'calibrated_pure_tone' && !calibrationSavedForDevice)}
            onPress={testMode === 'universal_screening' ? startScreeningFlow : beginRightEar}
          >
            <Text style={styles.primaryButtonText}>
              {testMode === 'universal_screening' ? 'Begin hearing screening' : 'Begin hearing test'}
            </Text>
          </TouchableOpacity>
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  if (phase === 'ear_intro') {
    const isRight = currentEar === 'right';
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>{isRight ? 'Right ear' : 'Left ear'}</Text>
          <Text style={[styles.appSub, { color: earColor }]}>
            {isRight ? 'O symbol · red' : 'X symbol · blue'}
          </Text>

          <View style={[styles.card, { borderWidth: 2, borderColor: `${earColor}55` }]}>
            <Text style={[styles.earSymbol, { color: earColor }]}>{isRight ? 'O' : 'X'}</Text>
            <Text style={styles.cardTitle}>{isRight ? 'Testing right ear' : 'Testing left ear'}</Text>
            <Text style={styles.cardBody}>
              Keep both sides of the headphones in place. The app will route tones only to the selected ear.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: earColor }]}
            onPress={() => {
              setPracticeDb(30);
              setPracticePassed(false);
              setPhase('familiarize');
            }}
          >
            <Text style={styles.primaryButtonText}>Start practice tone</Text>
          </TouchableOpacity>
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  // ─── v4.9: Universal Screening Mode phases ───

  if (phase === 'screening_ear_intro') {
    const isRight = screeningEar === 'right';
    const color = isRight ? RIGHT_COLOR : LEFT_COLOR;
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>{isRight ? 'Right ear' : 'Left ear'}</Text>
          <Text style={[styles.appSub, { color }]}>Hearing screening · tone-in-noise</Text>

          <View style={[styles.card, { borderWidth: 2, borderColor: `${color}55` }]}>
            <Text style={[styles.earSymbol, { color }]}>{isRight ? 'O' : 'X'}</Text>
            <Text style={styles.cardTitle}>{isRight ? 'Screening right ear' : 'Screening left ear'}</Text>
            <Text style={styles.cardBody}>
              You'll hear a steady hissing noise. Sometimes a faint tone will be mixed into it —
              press "I heard a tone" only when you actually detect one. Some trials have no tone
              at all; that's expected and checks how reliable your responses are.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: color }]}
            onPress={() => setPhase('screening_test')}
          >
            <Text style={styles.primaryButtonText}>Continue</Text>
          </TouchableOpacity>
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  if (phase === 'screening_test') {
    const isRight = screeningEar === 'right';
    const color = isRight ? RIGHT_COLOR : LEFT_COLOR;
    const freq = SCREENING_FREQUENCIES[screeningFreqIndex];
    const progress = Math.round(
      ((screeningFreqIndex + (screeningEar === 'left' ? SCREENING_FREQUENCIES.length : 0)) /
        (SCREENING_FREQUENCIES.length * 2)) *
        100,
    );

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>HearSmart Screening</Text>
          <EarBadge ear={screeningEar} />
          <Text style={styles.stepCountText}>
            Frequency {screeningFreqIndex + 1} of {SCREENING_FREQUENCIES.length} · trial{' '}
            {Math.min(screeningTrialCountRef.current + 1, SCREENING_TRIALS_PER_FREQUENCY)} of{' '}
            {SCREENING_TRIALS_PER_FREQUENCY}
          </Text>

          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: color }]} />
          </View>

          <View style={styles.dbCard}>
            <Text style={[styles.levelLabel, { color }]}>{formatFrequency(freq)}</Text>
            <Text style={styles.dbUnit}>tone mixed into steady noise — listen carefully</Text>
            <Text style={styles.smallNote}>
              This mode measures how the tone compares to the background noise, not an absolute
              loudness level, so no dB number is shown here.
            </Text>
          </View>

          <TouchableOpacity
            style={[styles.playButton, isPlaying && styles.stopButton]}
            onPress={isPlaying ? cancelTone : playScreeningTrial}
          >
            <Text style={styles.playButtonText}>{isPlaying ? 'Stop' : 'Play sound'}</Text>
          </TouchableOpacity>

          {screeningTonePlayed ? (
            <View style={styles.responseRow}>
              <TouchableOpacity style={styles.heardButton} onPress={() => handleScreeningResponse(true)}>
                <Text style={styles.heardButtonText}>✓ I heard a tone</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.notHeardButton} onPress={() => handleScreeningResponse(false)}>
                <Text style={styles.notHeardButtonText}>No tone / just noise</Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  if (phase === 'screening_done') {
    const summary = computeScreeningSummary(screeningResults, screeningCatchLog);

    const outcomeCard = (ear, outcome) => {
      const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
      const label = !summary.reliable
        ? 'INCONCLUSIVE'
        : outcome === 'PASS'
          ? 'PASS'
          : outcome === 'REFER'
            ? 'REFER'
            : 'INCOMPLETE';
      const labelColor =
        label === 'PASS' ? '#059669' : label === 'REFER' ? '#DC2626' : '#D97706';

      return (
        <View style={[styles.resultCard, { borderColor: `${color}55` }]} key={ear}>
          <Text style={[styles.resultTitle, { color }]}>{ear === 'right' ? 'O Right ear' : 'X Left ear'}</Text>
          <Text style={[styles.resultPta, { color: labelColor, fontSize: 34 }]}>{label}</Text>
          {label === 'REFER' ? (
            <Text style={styles.resultRecommendation}>
              A professional hearing assessment is recommended.
            </Text>
          ) : label === 'INCONCLUSIVE' ? (
            <Text style={styles.resultRecommendation}>
              Response reliability was too low to trust this outcome. Please retest in a quieter
              environment, responding only when you genuinely detect a tone.
            </Text>
          ) : (
            <Text style={styles.resultRecommendation}>
              No elevated screening response detected. Repeat screening periodically.
            </Text>
          )}
        </View>
      );
    };

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Screening complete</Text>
          <Text style={styles.appSub}>Universal hearing screening · not a pure-tone dB HL test</Text>

          <View style={[styles.card, !summary.reliable && { borderColor: '#DC2626', borderWidth: 2 }]}>
            <Text style={styles.cardTitle}>Response reliability</Text>
            <Text style={styles.cardBody}>
              {summary.catchTotal} silent catch trial{summary.catchTotal === 1 ? '' : 's'} ·{' '}
              {summary.falsePositives} false positive response{summary.falsePositives === 1 ? '' : 's'}
              {'\n'}
              {summary.reliable
                ? '✓ Reliability acceptable'
                : '⚠ Reliability too low — treat results as inconclusive and consider retesting'}
            </Text>
          </View>

          {outcomeCard('right', summary.rightOutcome)}
          {outcomeCard('left', summary.leftOutcome)}

          <View style={styles.disclaimerCard}>
            <Text style={styles.disclaimerText}>
              This screening uses a tone-in-noise signal, not validated recorded speech
              (digits-in-noise), and has not been validated against clinical outcomes. It never
              reports dB HL or a degree of hearing loss — only PASS / REFER / INCONCLUSIVE. A
              REFER or INCONCLUSIVE result means "get a professional assessment," not a diagnosis.
            </Text>
          </View>

          <TouchableOpacity style={styles.secondaryButton} onPress={resetAll}>
            <Text style={styles.secondaryButtonText}>Start a new test</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'familiarize') {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Practice</Text>
          <EarBadge ear={currentEar} />
          <Text style={styles.stepCountText}>1000 Hz</Text>
          <VolumeGate systemVolume={systemVolume} volumeLoading={volumeLoading} volumeReady={volumeReady} onSetTargetVolume={setTargetVolume} />

          <View style={styles.dbCard}>
            <Text style={styles.levelLabel}>Practice level</Text>
            <Text style={styles.dbNumber}>{practiceDb}</Text>
            <Text style={styles.dbUnit}>estimated dB HL</Text>
          </View>

          <TouchableOpacity
            style={[styles.playButton, isPlaying && styles.stopButton]}
            onPress={
              isPlaying
                ? cancelTone
                : () => playTone(1000, practiceDb, currentEar)
            }
          >
            <Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : 'Play practice tone'}</Text>
          </TouchableOpacity>

          {tonePlayed ? (
            <View style={styles.responseRow}>
              <TouchableOpacity style={styles.heardButton} onPress={() => handlePracticeResponse(true)}>
                <Text style={styles.heardButtonText}>✓ I heard it</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.notHeardButton} onPress={() => handlePracticeResponse(false)}>
                <Text style={styles.notHeardButtonText}>Nothing</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {practicePassed ? (
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: earColor }]}
              onPress={beginTestingCurrentEar}
            >
              <Text style={styles.primaryButtonText}>Begin real test</Text>
            </TouchableOpacity>
          ) : (
            <>
              <Text style={styles.smallNote}>The real test starts only after the practice tone is detected.</Text>
              {practiceDb >= 60 ? (
                <TouchableOpacity style={styles.secondaryButton} onPress={() => goToCalibration('familiarize')}>
                  <Text style={styles.secondaryButtonText}>Not hearing anything? Re-run calibration</Text>
                </TouchableOpacity>
              ) : null}
            </>
          )}
        </ScrollView>
        <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
      </SafeAreaView>
    );
  }

  if (phase === 'done') {
    const rightPta = computeFourFrequencyPTA(thresholds.right);
    const leftPta = computeFourFrequencyPTA(thresholds.left);
    const rightClassification = classify(rightPta);
    const leftClassification = classify(leftPta);

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Test complete</Text>
          <Text style={styles.appSub}>Both ears tested</Text>

          <View style={styles.audiogramCard}>
            <Text style={[styles.cardTitle, { color: '#0A1628' }]}>Audiogram</Text>
            <Text style={styles.audiogramLegend}>
              <Text style={{ color: RIGHT_COLOR, fontWeight: '700' }}>O right</Text>
              {'   ·   '}
              <Text style={{ color: LEFT_COLOR, fontWeight: '700' }}>X left</Text>
              {'   ·   ↓ no response'}
            </Text>
            <Audiogram rightResults={thresholds.right} leftResults={thresholds.left} />
          </View>

          {hasCalibrationLimitWarning(calibrationLimitReached) ? (
            <View style={[styles.card, { borderColor: '#DC2626', borderWidth: 2 }]}>
              <Text style={[styles.cardTitle, { color: '#FCA5A5' }]}>
                ⚠ Calibration reached its limit
              </Text>
              <Text style={styles.cardBody}>
                During calibration, at least one frequency was still not comfortably audible even
                at the maximum correction this app allows. This is more likely to reflect real
                reduced sensitivity at that frequency than a quiet device — this app cannot tell
                the difference between the two. Treat any "normal" result below with caution and
                consider a professional hearing assessment regardless of what this screening shows.
              </Text>
            </View>
          ) : null}

          <View style={styles.diagnosisCard}>
            <Text style={styles.diagnosisTitle}>Provisional diagnosis</Text>
            <Text style={styles.diagnosisText}>{buildProvisionalDiagnosis(rightPta, leftPta)}</Text>
          </View>

          <EarResults
            ear="right"
            results={thresholds.right}
            pta={rightPta}
            classification={rightClassification}
            calibrationProfile={calibrationProfile}
          />
          <EarResults
            ear="left"
            results={thresholds.left}
            pta={leftPta}
            classification={leftClassification}
            calibrationProfile={calibrationProfile}
          />

          <TouchableOpacity style={styles.shareButton} onPress={exportPdf} disabled={exporting}>
            {exporting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <Text style={styles.shareButtonText}>Export and share PDF report</Text>
            )}
          </TouchableOpacity>

          <View style={styles.disclaimerCard}>
            <Text style={styles.disclaimerText}>
              Estimated dB HL only. Generic headphones are not physically calibrated. This air-conduction screening cannot diagnose hearing loss type, replace masking, or replace a licensed audiology assessment.
            </Text>
          </View>

          <TouchableOpacity style={styles.secondaryButton} onPress={resetAll}>
            <Text style={styles.secondaryButtonText}>Start a new test</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const currentWindow = ascendingWindowDisplay;
  const heardInWindow = currentWindow.filter(Boolean).length;
  const progress = activeSteps.length
    ? Math.round((stepIndex / activeSteps.length) * 100)
    : 0;

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.appName}>HearSmart</Text>
        <EarBadge ear={currentEar} />
        <Text style={styles.stepCountText}>
          Step {stepIndex + 1} of {activeSteps.length}
        </Text>

        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: earColor }]} />
        </View>

        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ width: '100%', marginBottom: 14 }}
          contentContainerStyle={{ gap: 6 }}
        >
          {activeSteps.map((item, index) => {
            const done = Boolean(thresholds[currentEar]?.[item.id]);
            const active = index === stepIndex;
            return (
              <View
                key={item.id}
                style={[
                  styles.stepChip,
                  done && styles.stepChipDone,
                  active && { borderColor: earColor, backgroundColor: `${earColor}25` },
                ]}
              >
                <Text style={[styles.stepChipText, (done || active) && { color: '#FFFFFF' }]}>
                  {item.label}{done ? ' ✓' : ''}
                </Text>
              </View>
            );
          })}
        </ScrollView>

        {thresholdBanner ? (
          <View style={styles.thresholdBanner}>
            <Text style={styles.thresholdBannerTitle}>Result stored</Text>
            <Text style={styles.thresholdBannerFrequency}>
              {formatFrequency(thresholdBanner.frequency)} · {thresholdBanner.label}
            </Text>
            <Text style={styles.thresholdBannerValue}>{formatResult(thresholdBanner.result)}</Text>
          </View>
        ) : null}

        <View style={styles.dbCard}>
          <Text style={[styles.levelLabel, { color: earColor }]}>
            {formatFrequency(currentFrequency)}
            {currentStep?.id.includes('retest') || currentStep?.id.includes('recheck') ? ' · retest' : ''}
          </Text>
          <Text style={styles.dbNumber}>{currentDb}</Text>
          <Text style={styles.dbUnit}>estimated dB HL</Text>

          <Text style={styles.smallNote}>
            Digital gain for this level: {dbHLToAmplitude(currentDb, currentFrequency, calibrationProfile).dBFS.toFixed(1)} dBFS
            {dbHLToAmplitude(currentDb, currentFrequency, calibrationProfile).clipped ? ' (at device max)' : ''}
          </Text>

          <Text style={styles.directionText}>
            {!hadDescentDisplay
              ? 'Initial search — responses do not yet count toward threshold'
              : directionDisplay === 'asc'
                ? 'Ascending presentation — counts toward threshold'
                : 'Descending presentation'}
          </Text>

          {currentWindow.length > 0 ? (
            <View style={[styles.windowBadge, { borderColor: earColor }]}>
              <Text style={{ color: earColor, fontWeight: '700' }}>
                Last ascending trials at this level: {heardInWindow}/{currentWindow.length} heard
                {' · need 2 heard to confirm threshold'}
              </Text>
            </View>
          ) : null}

          {lastFeedback ? (
            <Text style={{ color: lastFeedback.heard ? '#059669' : '#DC2626', marginTop: 12, fontWeight: '700' }}>
              {lastFeedback.note ?? `${lastFeedback.heard ? 'Heard' : 'Not heard'} → ${lastFeedback.delta > 0 ? '+' : ''}${lastFeedback.delta} dB`}
            </Text>
          ) : null}
        </View>

        <TouchableOpacity
          style={[styles.playButton, isPlaying && styles.stopButton, thresholdBanner && styles.disabledButton]}
          disabled={Boolean(thresholdBanner)}
          onPress={
            isPlaying
              ? cancelTone
              : () => playTone(currentFrequency, currentDb, currentEar)
          }
        >
          <Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : 'Play tone'}</Text>
        </TouchableOpacity>

        {tonePlayed && !thresholdBanner ? (
          <View style={styles.responseRow}>
            <TouchableOpacity style={styles.heardButton} onPress={() => handleTestResponse(true)}>
              <Text style={styles.heardButtonText}>✓ I heard it</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.notHeardButton} onPress={() => handleTestResponse(false)}>
              <Text style={styles.notHeardButtonText}>Nothing</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {history.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Current-frequency trial log</Text>
            <View style={styles.logWrap}>
              {history.map((item, index) => (
                <View
                  key={`${item.stepId}-${index}`}
                  style={[
                    styles.logChip,
                    { backgroundColor: item.heard ? '#064E3B' : '#450A0A' },
                  ]}
                >
                  <Text style={{ color: item.heard ? '#6EE7B7' : '#FCA5A5', fontSize: 11 }}>
                    {item.heard ? '✓' : '✗'} {item.db} {item.validAscending ? '↑' : '↓'}
                  </Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <TouchableOpacity style={styles.resetLink} onPress={resetAll}>
          <Text style={styles.resetLinkText}>Start over</Text>
        </TouchableOpacity>
      </ScrollView>
      <VolumeBlockedOverlay volumeBlocked={volumeBlocked} systemVolume={systemVolume} onSetTargetVolume={setTargetVolume} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#0A1628',
  },
  scroll: {
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 52,
  },
  appName: {
    color: '#FFFFFF',
    fontSize: 34,
    fontWeight: '900',
    letterSpacing: -0.8,
  },
  appSub: {
    color: ACCENT,
    fontSize: 12,
    marginTop: 3,
    marginBottom: 20,
    textAlign: 'center',
  },
  earBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderRadius: 24,
    paddingVertical: 7,
    paddingHorizontal: 16,
    marginTop: 8,
    gap: 9,
  },
  earBadgeSymbolWrap: {
    width: 24,
    height: 24,
    borderRadius: 12,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  earBadgeSymbol: {
    fontSize: 13,
    fontWeight: '900',
  },
  earBadgeText: {
    fontSize: 13,
    fontWeight: '900',
    letterSpacing: 1,
  },
  stepCountText: {
    color: '#64748B',
    fontSize: 11,
    marginTop: 8,
    marginBottom: 18,
    textAlign: 'center',
  },
  card: {
    width: '100%',
    backgroundColor: '#101E30',
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
  },
  cardTitle: {
    color: '#FFFFFF',
    fontSize: 17,
    fontWeight: '800',
    marginBottom: 12,
    textAlign: 'center',
  },
  cardBody: {
    color: '#CBD5E1',
    fontSize: 14,
    lineHeight: 21,
    textAlign: 'center',
  },
  input: {
    width: '100%',
    color: '#FFFFFF',
    backgroundColor: '#0A1628',
    borderColor: '#29445F',
    borderWidth: 1,
    borderRadius: 11,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 10,
    fontSize: 14,
  },
  sexRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 10,
  },
  sexPill: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#29445F',
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: 'center',
  },
  sexPillActive: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  sexPillText: {
    color: '#94A3B8',
    fontSize: 12,
    fontWeight: '700',
  },
  sexPillTextActive: {
    color: '#07131F',
  },
  checkRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 11,
  },
  checkCircle: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#0D6E8A',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 10,
    marginTop: 1,
  },
  checkNumber: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '800',
  },
  checkText: {
    color: '#94A3B8',
    flex: 1,
    fontSize: 13,
    lineHeight: 19,
  },
  confirmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingVertical: 8,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: '#64748B',
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxChecked: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
  },
  checkboxText: {
    color: '#0A1628',
    fontWeight: '900',
  },
  confirmText: {
    color: '#CBD5E1',
    fontSize: 13,
  },
  primaryButton: {
    backgroundColor: ACCENT,
    borderRadius: 30,
    paddingVertical: 15,
    paddingHorizontal: 28,
    minWidth: 220,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    color: '#07131F',
    fontSize: 15,
    fontWeight: '900',
    textAlign: 'center',
  },
  secondaryButton: {
    borderColor: '#2D5876',
    borderWidth: 1,
    borderRadius: 24,
    paddingVertical: 11,
    paddingHorizontal: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 10,
  },
  secondaryButtonText: {
    color: '#7DD3FC',
    fontWeight: '800',
  },
  disabledButton: {
    opacity: 0.38,
  },
  volumeCard: {
    width: '100%',
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    alignItems: 'center',
    borderWidth: 1.5,
  },
  volumeReady: {
    backgroundColor: '#052E2A',
    borderColor: '#059669',
  },
  volumeNotReady: {
    backgroundColor: '#331515',
    borderColor: '#DC2626',
  },
  volumeTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  volumeNumber: {
    color: '#FFFFFF',
    fontSize: 44,
    fontWeight: '900',
    marginTop: 4,
  },
  volumeStatus: {
    fontSize: 12,
    fontWeight: '700',
  },
  channelButton: {
    borderWidth: 1.5,
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginTop: 14,
  },
  channelButtonText: {
    fontWeight: '800',
  },
  earSymbol: {
    fontSize: 68,
    fontWeight: '900',
    textAlign: 'center',
    marginBottom: 6,
  },
  dbCard: {
    width: '100%',
    backgroundColor: '#101E30',
    borderColor: '#29445F',
    borderWidth: 1,
    borderRadius: 20,
    alignItems: 'center',
    padding: 24,
    marginBottom: 18,
  },
  levelLabel: {
    color: ACCENT,
    fontSize: 13,
    fontWeight: '700',
  },
  dbNumber: {
    color: '#FFFFFF',
    fontSize: 78,
    fontWeight: '900',
    letterSpacing: -3,
    lineHeight: 88,
  },
  dbUnit: {
    color: '#64748B',
    fontSize: 12,
  },
  directionText: {
    color: '#94A3B8',
    fontSize: 11,
    marginTop: 12,
    textAlign: 'center',
  },
  windowBadge: {
    marginTop: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 7,
    paddingHorizontal: 10,
  },
  playButton: {
    backgroundColor: ACCENT,
    borderRadius: 32,
    minWidth: 230,
    paddingVertical: 18,
    alignItems: 'center',
    marginBottom: 16,
  },
  stopButton: {
    backgroundColor: '#EF4444',
  },
  playButtonText: {
    color: '#07131F',
    fontSize: 18,
    fontWeight: '900',
  },
  responseRow: {
    width: '100%',
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
    marginBottom: 16,
  },
  heardButton: {
    flex: 1,
    backgroundColor: '#064E3B',
    borderColor: '#059669',
    borderWidth: 1.5,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  heardButtonText: {
    color: '#6EE7B7',
    fontWeight: '900',
    textAlign: 'center',
  },
  notHeardButton: {
    flex: 1,
    backgroundColor: '#450A0A',
    borderColor: '#B91C1C',
    borderWidth: 1.5,
    borderRadius: 16,
    paddingVertical: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notHeardButtonText: {
    color: '#FCA5A5',
    fontWeight: '900',
    textAlign: 'center',
  },
  smallNote: {
    color: '#64748B',
    fontSize: 11,
    textAlign: 'center',
  },
  progressTrack: {
    width: '100%',
    height: 6,
    backgroundColor: '#1E3349',
    borderRadius: 3,
    overflow: 'hidden',
    marginBottom: 16,
  },
  progressFill: {
    height: '100%',
  },
  stepChip: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#29445F',
    backgroundColor: '#101E30',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stepChipDone: {
    backgroundColor: '#064E3B',
    borderColor: '#059669',
  },
  stepChipText: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '700',
  },
  thresholdBanner: {
    width: '100%',
    backgroundColor: '#064E3B',
    borderColor: ACCENT,
    borderWidth: 2,
    borderRadius: 18,
    padding: 18,
    alignItems: 'center',
    marginBottom: 15,
  },
  thresholdBannerTitle: {
    color: ACCENT,
    textTransform: 'uppercase',
    fontSize: 11,
    letterSpacing: 1.2,
    fontWeight: '800',
  },
  thresholdBannerFrequency: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '800',
    marginTop: 4,
  },
  thresholdBannerValue: {
    color: ACCENT,
    fontSize: 28,
    fontWeight: '900',
    marginTop: 3,
  },
  logWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  logChip: {
    borderRadius: 8,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  audiogramCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 8,
    marginBottom: 16,
    alignItems: 'center',
  },
  audiogramLegend: {
    color: '#64748B',
    fontSize: 10,
    marginBottom: 3,
  },
  diagnosisCard: {
    width: '100%',
    backgroundColor: '#101E30',
    borderColor: '#0D6E8A',
    borderWidth: 1.5,
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  diagnosisTitle: {
    color: '#7DD3FC',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
    letterSpacing: 1,
    marginBottom: 6,
  },
  diagnosisText: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
  },
  resultCard: {
    width: '100%',
    backgroundColor: '#101E30',
    borderWidth: 1.5,
    borderRadius: 18,
    padding: 18,
    marginBottom: 16,
    alignItems: 'center',
  },
  resultTitle: {
    fontSize: 18,
    fontWeight: '900',
  },
  resultPta: {
    fontSize: 46,
    fontWeight: '900',
    letterSpacing: -2,
    marginTop: 8,
  },
  classification: {
    fontSize: 14,
    fontWeight: '800',
    marginTop: 10,
  },
  resultRecommendation: {
    color: '#94A3B8',
    textAlign: 'center',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 5,
  },
  reliabilityBox: {
    width: '100%',
    backgroundColor: '#0A1628',
    borderRadius: 10,
    padding: 10,
    marginTop: 12,
  },
  resultRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomColor: '#20364D',
    borderBottomWidth: 1,
    paddingVertical: 8,
  },
  resultFrequency: {
    color: '#CBD5E1',
    fontSize: 12,
  },
  resultValue: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
  },
  shareButton: {
    width: '100%',
    backgroundColor: '#0D6E8A',
    borderRadius: 16,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 14,
  },
  shareButtonText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 15,
  },
  disclaimerCard: {
    width: '100%',
    backgroundColor: '#2A2010',
    borderColor: '#B45309',
    borderWidth: 1,
    borderRadius: 12,
    padding: 13,
    marginBottom: 14,
  },
  disclaimerText: {
    color: '#FDE68A',
    fontSize: 10,
    lineHeight: 16,
    textAlign: 'center',
  },
  resetLink: {
    padding: 12,
    marginTop: 6,
  },
  resetLinkText: {
    color: '#64748B',
    fontSize: 12,
  },
  blockOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.78)',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 22,
    zIndex: 100,
  },
  blockCard: {
    width: '100%',
    maxWidth: 420,
    backgroundColor: '#101E30',
    borderColor: '#EF4444',
    borderWidth: 2,
    borderRadius: 18,
    padding: 22,
    alignItems: 'center',
  },
  blockTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    textAlign: 'center',
  },
  blockBody: {
    color: '#CBD5E1',
    textAlign: 'center',
    lineHeight: 20,
    marginVertical: 12,
  },
  blockVolume: {
    color: '#FCA5A5',
    fontSize: 18,
    fontWeight: '800',
    marginBottom: 16,
  },
});

