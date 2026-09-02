/**
 * HearSmart v4.0 — smartphone pure-tone hearing-screening research prototype
 *
 * IMPORTANT:
 * - This is NOT a clinically calibrated audiometer.
 * - Results are reported as estimated dB HL.
 * - Automatic system-volume read/set/live-monitoring is implemented on Android
 *   via react-native-volume-manager. It requires a custom Expo development
 *   client — it will NOT work inside Expo Go.
 * - On iOS, Apple does not allow apps to read or set the system volume
 *   programmatically, so iOS keeps a manual "I set it to max" confirmation
 *   flow. This is a platform limitation, not a bug.
 * - Right/left routing is implemented with a stereo PCM WAV.
 * - Threshold rule: 2 responses in the most recent 3 valid ascending trials.
 *
 * Required packages:
 *   npx expo install expo-av expo-print expo-sharing expo-device react-native-svg expo-dev-client expo-build-properties
 *   npm install react-native-volume-manager@2.0.8 base64-arraybuffer
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

const APP_VERSION = '4.0.0';

// iOS uses manual max-volume confirmation.
// Android uses dynamic media-volume control before every tone.
const IOS_TARGET_VOLUME = 1.0;
const TARGET_VOLUME = 1.0; // kept for old UI/report compatibility
const VOLUME_TOLERANCE = 0.025;

// Professor whiteboard calibration model:
// 100% volume ≈ 105 dB SPL
// 50% volume  ≈ 99 dB SPL
// 25% volume  ≈ 93 dB SPL
// 12.5% volume ≈ 87 dB SPL
const ANDROID_SPL_AT_FULL_VOLUME = 105;
const ANDROID_MIN_MASTER_VOLUME = 0.125;
const ANDROID_MAX_MASTER_VOLUME = 1.0;

const MIN_DB = -10;
// A conservative prototype ceiling because generic headphones are uncalibrated.
const MAX_DB = 80;
const DEFAULT_START_DB = 20;
const STEP_UP = 5;
const STEP_DOWN = 10;
const TONE_DURATION_SEC = 1.2;
const RAMP_MS = 50;

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
// tone) when the system/master volume is at 100%.
//
// Source: sound-level-meter measurement at 1 kHz, whiteboard reference:
//   105 dB SPL -> 100% volume
//    99 dB SPL ->  50% volume
//    93 dB SPL ->  25% volume
//    87 dB SPL -> 12.5% volume
// (each halving of volume drops output by ~6 dB, i.e. 20*log10(0.5) = -6.02 dB,
// which is the expected relationship for a linear-amplitude volume control —
// this internally-consistent progression is a good sanity check that the
// measurement itself is sound.)
//
// This app always plays back at 100% system volume and does all attenuation
// digitally (see dbHLToAmplitude), so only the 105 dB SPL @ 100% figure is
// used directly. It was previously hardcoded to a 100 dB SPL placeholder,
// which meant every reported dB HL value was off by a flat 5 dB from what was
// actually measured for this phone/headphone pair.
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

// ─────────────────────────────────────────────────────────────────────────────
// Result helpers
// ─────────────────────────────────────────────────────────────────────────────

function thresholdResult(db) {
  return { kind: 'threshold', db };
}

function noResponseResult(maxDb) {
  return { kind: 'no_response', maxDb };
}

function resultDb(result) {
  return result?.kind === 'threshold' ? result.db : null;
}

function classify(db) {
  if (db == null) return null;
  if (db <= 25) {
    return {
      label: 'Within normal screening range',
      color: '#059669',
      recommendation: 'Repeat screening periodically or sooner if symptoms develop.',
    };
  }
  if (db <= 40) {
    return {
      label: 'Mild range',
      color: '#D97706',
      recommendation: 'A professional audiology assessment is recommended.',
    };
  }
  if (db <= 55) {
    return {
      label: 'Moderate range',
      color: '#EA580C',
      recommendation: 'Arrange a professional audiology and ENT assessment.',
    };
  }
  if (db <= 70) {
    return {
      label: 'Moderately severe range',
      color: '#DC2626',
      recommendation: 'Prompt professional audiology and ENT assessment is recommended.',
    };
  }
  return {
    label: 'Severe screening range',
    color: '#991B1B',
    recommendation: 'Prompt professional audiology and ENT assessment is recommended.',
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

function formatFrequency(freq) {
  return freq >= 1000 ? `${freq / 1000} kHz` : `${freq} Hz`;
}

function formatResult(result) {
  if (!result) return '—';
  if (result.kind === 'no_response') return `NR at ${result.maxDb} dB`;
  return `${result.db} dB`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// ─────────────────────────────────────────────────────────────────────────────
// SPL → estimated dB HL prototype mapping
// ─────────────────────────────────────────────────────────────────────────────

function getAndroidMasterVolumePlan(dbHL, frequencyHz) {
  const zeroHlSpl = ZERO_HL_REFERENCE_SPL[frequencyHz];

  if (zeroHlSpl == null) {
    throw new Error(`Missing HL reference entry for ${frequencyHz} Hz.`);
  }

  const targetSpl = dbHL + zeroHlSpl;

  // Main professor logic:
  // target SPL is produced by moving Android media/master volume.
  const rawVolume = Math.pow(
    10,
    (targetSpl - ANDROID_SPL_AT_FULL_VOLUME) / 20,
  );

  const masterVolume = Math.max(
    ANDROID_MIN_MASTER_VOLUME,
    Math.min(ANDROID_MAX_MASTER_VOLUME, rawVolume),
  );

  // If the desired SPL is below what 12.5% master volume can provide,
  // keep master volume at 12.5% and use small digital trim for the rest.
  // This keeps the professor's master-knob approach while still allowing
  // lower screening levels.
  const digitalTrim =
    rawVolume < ANDROID_MIN_MASTER_VOLUME
      ? rawVolume / ANDROID_MIN_MASTER_VOLUME
      : 1;

  return {
    targetSpl,
    masterVolume,
    digitalTrim: Math.max(0.000001, Math.min(1, digitalTrim)),
    rawVolume,
  };
}

function getAndroidMasterVolumePlan(dbHL, frequencyHz) {
  const zeroHlSpl = ZERO_HL_REFERENCE_SPL[frequencyHz];

  if (zeroHlSpl == null) {
    throw new Error(`Missing HL reference entry for ${frequencyHz} Hz.`);
  }

  const targetSpl = dbHL + zeroHlSpl;

  // Main professor logic:
  // target SPL is produced by moving Android media/master volume.
  const rawVolume = Math.pow(
    10,
    (targetSpl - ANDROID_SPL_AT_FULL_VOLUME) / 20,
  );

  const masterVolume = Math.max(
    ANDROID_MIN_MASTER_VOLUME,
    Math.min(ANDROID_MAX_MASTER_VOLUME, rawVolume),
  );

  // If the desired SPL is below what 12.5% master volume can provide,
  // keep master volume at 12.5% and use small digital trim for the rest.
  // This keeps the professor's master-knob approach while still allowing
  // lower screening levels.
  const digitalTrim =
    rawVolume < ANDROID_MIN_MASTER_VOLUME
      ? rawVolume / ANDROID_MIN_MASTER_VOLUME
      : 1;

  return {
    targetSpl,
    masterVolume,
    digitalTrim: Math.max(0.000001, Math.min(1, digitalTrim)),
    rawVolume,
  };
}

function dbHLToAmplitude(dbHL, frequencyHz) {
  if (Platform.OS === 'android') {
    const plan = getAndroidMasterVolumePlan(dbHL, frequencyHz);
    return {
      amplitude: plan.digitalTrim,
      targetSpl: plan.targetSpl,
      dBFS: 20 * Math.log10(plan.digitalTrim),
    };
  }

  // iOS fallback: iPhone volume is set manually to maximum and the app
  // controls loudness using digital amplitude.
  const zeroHlSpl = ZERO_HL_REFERENCE_SPL[frequencyHz];
  const splAtZeroDbfs = PROTOTYPE_SPL_AT_0_DBFS[frequencyHz];

  if (zeroHlSpl == null || splAtZeroDbfs == null) {
    throw new Error(`Missing calibration entry for ${frequencyHz} Hz.`);
  }

  const targetSpl = dbHL + zeroHlSpl;
  const dBFS = targetSpl - splAtZeroDbfs;

  if (dBFS > 0) {
    throw new Error(
      `Requested level exceeds digital headroom at ${frequencyHz} Hz (${dBFS.toFixed(1)} dBFS).`,
    );
  }

  return {
    amplitude: Math.pow(10, dBFS / 20),
    targetSpl,
    dBFS,
  };
}

// 24-bit stereo PCM preserves much more low-level resolution than 16-bit PCM.
function writePcm24(view, offset, signedValue) {
  const value = signedValue < 0 ? signedValue + 0x1000000 : signedValue;
  view.setUint8(offset, value & 0xff);
  view.setUint8(offset + 1, (value >> 8) & 0xff);
  view.setUint8(offset + 2, (value >> 16) & 0xff);
}

function buildStereoWav(
  frequencyHz,
  dbHL,
  ear,
  durationSec = TONE_DURATION_SEC,
) {
  if (ear !== 'left' && ear !== 'right') {
    throw new Error('Ear must be "left" or "right".');
  }

  const sampleRate = 44100;
  const channels = 2;
  const bitsPerSample = 24;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const numSamples = Math.floor(sampleRate * durationSec);
  const rampSamples = Math.floor(sampleRate * (RAMP_MS / 1000));
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const { amplitude } = dbHLToAmplitude(dbHL, frequencyHz);

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

  const max24 = 0x7fffff;

  for (let index = 0; index < numSamples; index += 1) {
    let envelope = 1;

    if (index < rampSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * index) / rampSamples));
    } else if (index >= numSamples - rampSamples) {
      const remaining = numSamples - 1 - index;
      envelope = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));
    }

    const sine = Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate);
    const sample = Math.round(amplitude * envelope * sine * max24);
    const clamped = Math.max(-max24, Math.min(max24, sample));

    const left = ear === 'left' ? clamped : 0;
    const right = ear === 'right' ? clamped : 0;
    const offset = 44 + index * blockAlign;

    writePcm24(view, offset, left);
    writePcm24(view, offset + bytesPerSample, right);
  }

  return encodeBase64(buffer);
}

// ─────────────────────────────────────────────────────────────────────────────
// Audiogram (app)
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
// PDF audiogram
// ─────────────────────────────────────────────────────────────────────────────

function buildAudiogramSvg(rightResults, leftResults) {
  const width = 520;
  const height = 260;
  const padLeft = 44;
  const padRight = 18;
  const padTop = 20;
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

  const pointsFor = (results) =>
    frequencies
      .map((frequency) => {
        const result = acceptedResultForFrequency(results, frequency);
        if (!result) return null;
        const isNr = result.kind === 'no_response';
        const db = isNr ? result.maxDb : result.db;
        return { frequency, x: xFor(frequency), y: yFor(db), isNr };
      })
      .filter(Boolean);

  const rightPoints = pointsFor(rightResults);
  const leftPoints = pointsFor(leftResults);

  const pathFor = (points) => {
    const valid = points.filter((point) => !point.isNr);
    if (valid.length < 2) return '';
    return valid
      .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x},${point.y}`)
      .join(' ');
  };

  const grid = [
    ...frequencies.map(
      (frequency) => `
        <line x1="${xFor(frequency)}" y1="${padTop}" x2="${xFor(frequency)}" y2="${height - padBottom}" stroke="#d7dee7" stroke-width="1"/>
        <text x="${xFor(frequency)}" y="${height - 12}" text-anchor="middle" font-size="9" fill="#64748b">${frequency >= 1000 ? `${frequency / 1000}k` : frequency}</text>
      `,
    ),
    ...dbLines.map(
      (db) => `
        <line x1="${padLeft}" y1="${yFor(db)}" x2="${width - padRight}" y2="${yFor(db)}" stroke="${db === 25 ? '#86efac' : '#d7dee7'}" stroke-width="${db === 25 ? 1.5 : 1}"/>
        <text x="${padLeft - 6}" y="${yFor(db) + 3}" text-anchor="end" font-size="9" fill="#64748b">${db}</text>
      `,
    ),
  ].join('');

  const rightMarks = rightPoints
    .map(
      (point) => `
        <circle cx="${point.x}" cy="${point.y}" r="6" fill="#ffffff" stroke="${RIGHT_COLOR}" stroke-width="2"/>
        ${
          point.isNr
            ? `<line x1="${point.x}" y1="${point.y + 7}" x2="${point.x}" y2="${point.y + 17}" stroke="${RIGHT_COLOR}" stroke-width="2"/>
               <path d="M${point.x - 4},${point.y + 13} L${point.x},${point.y + 18} L${point.x + 4},${point.y + 13}" stroke="${RIGHT_COLOR}" stroke-width="2" fill="none"/>`
            : ''
        }
      `,
    )
    .join('');

  const leftMarks = leftPoints
    .map(
      (point) => `
        <line x1="${point.x - 6}" y1="${point.y - 6}" x2="${point.x + 6}" y2="${point.y + 6}" stroke="${LEFT_COLOR}" stroke-width="2"/>
        <line x1="${point.x + 6}" y1="${point.y - 6}" x2="${point.x - 6}" y2="${point.y + 6}" stroke="${LEFT_COLOR}" stroke-width="2"/>
        ${
          point.isNr
            ? `<line x1="${point.x}" y1="${point.y + 8}" x2="${point.x}" y2="${point.y + 18}" stroke="${LEFT_COLOR}" stroke-width="2"/>
               <path d="M${point.x - 4},${point.y + 14} L${point.x},${point.y + 19} L${point.x + 4},${point.y + 14}" stroke="${LEFT_COLOR}" stroke-width="2" fill="none"/>`
            : ''
        }
      `,
    )
    .join('');

  return `
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>
      <rect x="${padLeft}" y="${yFor(MIN_DB)}" width="${plotWidth}" height="${yFor(25) - yFor(MIN_DB)}" fill="#ecfdf5"/>
      ${grid}
      <text x="${padLeft + 4}" y="${yFor(25) - 5}" font-size="8" fill="#059669">Screening range ≤25 dB</text>
      ${pathFor(rightPoints) ? `<path d="${pathFor(rightPoints)}" stroke="${RIGHT_COLOR}" stroke-width="2" fill="none"/>` : ''}
      ${pathFor(leftPoints) ? `<path d="${pathFor(leftPoints)}" stroke="${LEFT_COLOR}" stroke-width="2" fill="none"/>` : ''}
      ${rightMarks}
      ${leftMarks}
      <text x="12" y="${height / 2}" text-anchor="middle" font-size="9" fill="#64748b" transform="rotate(-90 12 ${height / 2})">Estimated dB HL</text>
    </svg>
  `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Ear indicator (used on every in-test screen so it's always obvious which
// ear is currently being tested — this was previously only a small line of
// subtitle text on the main testing screen)
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
// Main app
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const [phase, setPhase] = useState('setup');
  const phaseRef = useRef('setup');

  const [participantName, setParticipantName] = useState('');
  const [testId, setTestId] = useState('');
  const [headphoneDescription, setHeadphoneDescription] = useState('');
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);

  const [systemVolume, setSystemVolume] = useState(null);
  const [volumeLoading, setVolumeLoading] = useState(true);
  const [volumeBlocked, setVolumeBlocked] = useState(false);

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

  const volumeReady =
    Platform.OS === 'android'
      ? systemVolume != null
      : systemVolume != null &&
        Math.abs(systemVolume - IOS_TARGET_VOLUME) <= VOLUME_TOLERANCE;

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
    responseLockedRef.current = false;
  }, [stopSound]);

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

            // In the professor version, volume is allowed to move because
            // the app itself changes Android media volume before each tone.
            // So we only display live volume here; we do not lock it to 100%.
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
        setSystemVolume(IOS_TARGET_VOLUME);
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

  async function setTargetVolume() {
    if (Platform.OS === 'android') {
      try {
        await VolumeManager.setVolume(ANDROID_MAX_MASTER_VOLUME, {
          type: 'music',
          playSound: false,
          showUI: false,
        });
        const confirmed = await VolumeManager.getVolume();
        setSystemVolume(confirmed.volume);
        setVolumeBlocked(false);
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
    setSystemVolume(IOS_TARGET_VOLUME);
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
          'Android system volume could not be read yet. Wait a moment and try again.',
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

      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        shouldDuckAndroid: false,
      });

      // PROFESSOR MASTER-KNOB LOGIC:
      // On Android, move the media/master volume before every tone based on
      // the requested estimated dB HL and the SPL calibration table.
      if (Platform.OS === 'android') {
        const plan = getAndroidMasterVolumePlan(dbHL, frequencyHz);

        await VolumeManager.setVolume(plan.masterVolume, {
          type: 'music',
          playSound: false,
          showUI: false,
        });

        setSystemVolume(plan.masterVolume);
        setVolumeBlocked(false);
      }

      const cacheKey = `${Platform.OS}:${frequencyHz}:${dbHL}:${ear}`;
      let base64 = toneCacheRef.current.get(cacheKey);
      if (!base64) {
        base64 = buildStereoWav(frequencyHz, dbHL, ear);
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
      if (window.length === 3) {
        const heardCount = window.filter(Boolean).length;
        if (heardCount >= 2) {
          finishStep(thresholdResult(db));
          return;
        }
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

  function resetAll() {
    clearTimers();
    cancelTone();
    thresholdsRef.current = { right: {}, left: {} };
    toneCacheRef.current.clear();
    testStartedAtRef.current = null;

    setParticipantName('');
    setTestId('');
    setHeadphoneDescription('');
    setHeadphonesConfirmed(false);
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

  function beginTestingCurrentEar() {
    const startDb = Math.max(MIN_DB, Math.min(40, practiceDb - 30));
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
        'You may continue, but results could show no response at several frequencies. A professional hearing assessment is recommended.',
      );
    }
  }

  function beginRightEar() {
    setCurrentEar('right');
    setPracticeDb(30);
    setPracticePassed(false);
    setPhase('ear_intro');
  }

  function buildTextReport() {
    const date = new Date().toLocaleString('en-IN');
    const lines = [
      'HearSmart Hearing-Screening Report',
      `Date: ${date}`,
      `Participant: ${participantName || 'Not provided'}`,
      `Test ID: ${testId || 'Not provided'}`,
      `Headphones: ${headphoneDescription || 'Not provided'}`,
      `System volume: ${Math.round((systemVolume ?? TARGET_VOLUME) * 100)}%`,
      'Calibration: Prototype generic profile; not physically calibrated',
      '',
    ];

    for (const ear of ['right', 'left']) {
      const earResults = thresholds[ear];
      const steps = getStepsForEar(ear, earResults);
      lines.push(`${ear.toUpperCase()} EAR`);
      for (const item of steps) {
        const result = earResults[item.id];
        if (result) {
          lines.push(`${formatFrequency(item.freq)} ${item.label}: ${formatResult(result)} estimated HL`);
        }
      }
      const pta = computeFourFrequencyPTA(earResults);
      lines.push(`Four-frequency PTA: ${pta == null ? 'Not available' : `${pta} dB estimated HL`}`);
      lines.push('');
    }

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
      const svg = buildAudiogramSvg(thresholds.right, thresholds.left);

      const buildEarRows = (ear) => {
        const earResults = thresholds[ear];
        return getStepsForEar(ear, earResults)
          .filter((item) => earResults[item.id])
          .map((item) => {
            const result = earResults[item.id];
            const interpolation = INTERPOLATED_FREQUENCIES.has(item.freq) ? ' *' : '';
            const note = item.id.includes('retest') || item.id.includes('recheck') ? ' (retest)' : '';
            return `
              <tr>
                <td>${formatFrequency(item.freq)}${interpolation}${note}</td>
                <td>${escapeHtml(formatResult(result))} estimated HL</td>
              </tr>
            `;
          })
          .join('');
      };

      const reliability = is1000RetestReliable(thresholds.right);
      const reliabilityHtml =
        reliability == null
          ? ''
          : reliability
            ? '<p class="good">✓ Right-ear 1 kHz retest is within 5 dB.</p>'
            : '<p class="warn">⚠ Right-ear 1 kHz retest differs by more than 5 dB. The lower 1 kHz value was used and 2 kHz was rechecked.</p>';

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
              .legend { display: flex; gap: 18px; margin: 8px 0 2px; }
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
              .disclaimer { border: 1px solid #f59e0b; background: #fffbeb; border-radius: 10px; padding: 12px; font-size: 10px; line-height: 1.55; }
            </style>
          </head>
          <body>
            <h1>HearSmart</h1>
            <div class="sub">Pure-tone hearing-screening research prototype · Report v${APP_VERSION}</div>

            <div class="meta">
              <div><strong>Participant:</strong> ${escapeHtml(participantName || 'Not provided')}</div>
              <div><strong>Test ID:</strong> ${escapeHtml(testId || 'Not provided')}</div>
              <div><strong>Report time:</strong> ${escapeHtml(reportTime.toLocaleString('en-IN'))}</div>
              <div><strong>Test started:</strong> ${escapeHtml(started ? started.toLocaleString('en-IN') : 'Not recorded')}</div>
              <div><strong>Device:</strong> ${escapeHtml(`${Device.modelName ?? 'Unknown'} · ${Device.osName ?? Platform.OS} ${Device.osVersion ?? ''}`)}</div>
              <div><strong>Headphones:</strong> ${escapeHtml(headphoneDescription || 'Not provided')}</div>
              <div><strong>System volume:</strong> ${Math.round((systemVolume ?? TARGET_VOLUME) * 100)}%</div>
              <div><strong>Calibration:</strong> Prototype generic profile; not physically calibrated</div>
            </div>

            <div class="section">
              <h2>Audiogram — both ears</h2>
              ${svg}
              <div class="legend">
                <span class="right">O = right ear</span>
                <span class="left">X = left ear</span>
                <span>↓ = no response at prototype ceiling</span>
              </div>
            </div>

            <div class="section">
              <h2 class="right">Right ear</h2>
              <div class="pta">${rightPta == null ? 'PTA unavailable' : `${rightPta} dB estimated HL`}</div>
              ${rightClass ? `<div class="classification" style="color:${rightClass.color}">${escapeHtml(rightClass.label)}</div><p>${escapeHtml(rightClass.recommendation)}</p>` : ''}
              ${reliabilityHtml}
              <table>
                <tr><th>Frequency</th><th>Result</th></tr>
                ${buildEarRows('right')}
              </table>
            </div>

            <div class="section">
              <h2 class="left">Left ear</h2>
              <div class="pta">${leftPta == null ? 'PTA unavailable' : `${leftPta} dB estimated HL`}</div>
              ${leftClass ? `<div class="classification" style="color:${leftClass.color}">${escapeHtml(leftClass.label)}</div><p>${escapeHtml(leftClass.recommendation)}</p>` : ''}
              <table>
                <tr><th>Frequency</th><th>Result</th></tr>
                ${buildEarRows('left')}
              </table>
            </div>

            <p class="note">* 3 kHz and 6 kHz use interpolated reference values. Four-frequency PTA uses 500, accepted 1000, 2000, and 4000 Hz when all four measured thresholds are available.</p>

            <div class="disclaimer">
              <strong>Important limitation:</strong> This application is an uncalibrated air-conduction screening prototype, not a medical device or clinical audiometer. The SPL-to-HL calculation uses reference values plus a prototype digital-output profile. Actual SPL depends on the exact phone, operating system, system volume, headphone model, fit, coupling, and acoustic environment. The test cannot distinguish conductive from sensorineural hearing loss and does not implement clinical masking. Confirm any abnormal, asymmetric, sudden, or concerning result with a licensed audiologist or ENT clinician.
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

  function VolumeGate() {
    const isAndroid = Platform.OS === 'android';
    return (
      <View style={[styles.volumeCard, volumeReady ? styles.volumeReady : styles.volumeNotReady]}>
        <Text style={styles.volumeTitle}>
          {isAndroid ? 'Android master volume (live)' : 'System volume buffer'}
        </Text>
        {volumeLoading ? (
          <ActivityIndicator color={ACCENT} />
        ) : (
          <>
            <Text style={styles.volumeNumber}>
              {systemVolume == null ? 'Unavailable' : `${Math.round(systemVolume * 100)}%`}
            </Text>
            <Text style={[styles.volumeStatus, { color: volumeReady ? '#059669' : '#DC2626' }]}>
              {volumeReady
                ? (isAndroid ? '✓ Dynamic volume ready' : '✓ Required volume confirmed')
                : (isAndroid ? 'Ready for dynamic volume' : 'Set iPhone volume to maximum')}
            </Text>
            <TouchableOpacity style={styles.secondaryButton} onPress={setTargetVolume}>
              <Text style={styles.secondaryButtonText}>
                {isAndroid ? 'Set volume to 100% for check' : 'I set iPhone volume to maximum'}
              </Text>
            </TouchableOpacity>
            {isAndroid ? (
              <Text style={styles.smallNote}>
                Android media volume will move automatically before each tone using the SPL calibration table.
              </Text>
            ) : null}
          </>
        )}
      </View>
    );
  }

  function VolumeBlockedOverlay() {
    if (!volumeBlocked) return null;
    return (
      <View style={styles.blockOverlay}>
        <View style={styles.blockCard}>
          <Text style={styles.blockTitle}>Volume changed — test paused</Text>
          <Text style={styles.blockBody}>
            {Platform.OS === 'android'
              ? 'The test paused because volume control was interrupted. The tone was cancelled and will not count.'
              : 'Set iPhone volume to maximum. The interrupted tone was cancelled and will not count.'}
          </Text>
          <Text style={styles.blockVolume}>
            Current: {systemVolume == null ? 'unknown' : `${Math.round(systemVolume * 100)}%`}
          </Text>
          <TouchableOpacity style={styles.primaryButton} onPress={setTargetVolume}>
            <Text style={styles.primaryButtonText}>
              {Platform.OS === 'android' ? 'Set volume to 100% for check and resume' : 'Continue after setting max volume'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (phase === 'setup') {
    const canContinue =
      volumeReady &&
      headphonesConfirmed &&
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
              value={testId}
              onChangeText={setTestId}
              placeholder="Test ID (optional)"
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
          </View>

          <VolumeGate />

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Before you begin</Text>
            {[
              'Use headphones or earphones; keep their position unchanged.',
              'Sit in the quietest room available and close doors and windows.',
              'Android: app changes media volume automatically. iPhone: keep volume at maximum.',
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
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, !canContinue && styles.disabledButton]}
            disabled={!canContinue}
            onPress={() => setPhase('channel_check')}
          >
            <Text style={styles.primaryButtonText}>Continue to channel check</Text>
          </TouchableOpacity>
        </ScrollView>
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
          <VolumeGate />

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
                    Alert.alert('Check failed', 'Verify headphone orientation and try again.');
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
                    Alert.alert('Check failed', 'Verify headphone orientation and try again.');
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

          <TouchableOpacity
            style={[styles.primaryButton, !bothConfirmed && styles.disabledButton]}
            disabled={!bothConfirmed}
            onPress={beginRightEar}
          >
            <Text style={styles.primaryButtonText}>Begin hearing test</Text>
          </TouchableOpacity>
        </ScrollView>
        <VolumeBlockedOverlay />
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
        <VolumeBlockedOverlay />
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
          <VolumeGate />

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
            <Text style={styles.smallNote}>The real test starts only after the practice tone is detected.</Text>
          )}
        </ScrollView>
        <VolumeBlockedOverlay />
      </SafeAreaView>
    );
  }

  if (phase === 'done') {
    const rightPta = computeFourFrequencyPTA(thresholds.right);
    const leftPta = computeFourFrequencyPTA(thresholds.left);
    const rightClassification = classify(rightPta);
    const leftClassification = classify(leftPta);

    const EarResults = ({ ear, results, pta, classification }) => {
      const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
      const steps = getStepsForEar(ear, results);
      return (
        <View style={[styles.resultCard, { borderColor: `${color}55` }]}>
          <Text style={[styles.resultTitle, { color }]}>
            {ear === 'right' ? 'O Right ear' : 'X Left ear'}
          </Text>
          <Text style={[styles.resultPta, { color: classification?.color ?? '#CBD5E1' }]}>
            {pta == null ? 'PTA unavailable' : `${pta} dB`}
          </Text>
          <Text style={styles.dbUnit}>four-frequency estimated PTA</Text>
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
              .map((item) => (
                <View key={item.id} style={styles.resultRow}>
                  <Text style={styles.resultFrequency}>
                    {formatFrequency(item.freq)}
                    {item.id.includes('retest') || item.id.includes('recheck') ? ' ↺' : ''}
                    {INTERPOLATED_FREQUENCIES.has(item.freq) ? ' *' : ''}
                  </Text>
                  <Text style={styles.resultValue}>{formatResult(results[item.id])}</Text>
                </View>
              ))}
          </View>
        </View>
      );
    };

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

          <EarResults
            ear="right"
            results={thresholds.right}
            pta={rightPta}
            classification={rightClassification}
          />
          <EarResults
            ear="left"
            results={thresholds.left}
            pta={leftPta}
            classification={leftClassification}
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

  // Main testing screen
  const currentWindow = ascendingWindowsRef.current[currentDb] ?? [];
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
                {currentWindow.length < 3 ? ' · need 3 trials' : ' · need at least 2/3'}
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
      <VolumeBlockedOverlay />
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