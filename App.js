// HearSmart v7.0.0 — calibration-aware pure-tone audiometry research system.
// Air-conduction values are profile-calibrated estimates unless an acoustic profile is used.


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
  AppState,
  Keyboard,
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
import {
  createAudioPlayer,
  setAudioModeAsync,
  setIsAudioActiveAsync,
} from 'expo-audio';
import * as Device from 'expo-device';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { VolumeManager } from 'react-native-volume-manager';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { encode as encodeBase64, decode as decodeBase64 } from 'base64-arraybuffer';
import Svg, {
  Circle,
  Line,
  Path,
  Rect,
  Text as SvgText,
} from 'react-native-svg';


const APP_VERSION = '8.0.0';
const DEFAULT_SYSTEM_VOLUME = 0.8;
const VOLUME_TOLERANCE = 0.04;

const MIN_DB = -10;
const MAX_DB = 100;
const MAX_BIO_DB = 80;
const AUDIOGRAM_DISPLAY_MAX_DB = 120;
const DEFAULT_START_DB = 40;
const STEP_UP = 5;
const STEP_DOWN = 10;
const TONE_DURATION_SEC = 1.2;
const RAMP_MS = 50;

const PURE_TONE_FREQUENCIES = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
const BIO_CAL_ORDER = [1000, 2000, 3000, 4000, 6000, 8000, 500, 250];
const BIO_CAL_START_DBFS = -45;
const BIO_CAL_MIN_DBFS = -90;
const BASE_TONE_PEAK = 0.5;
const BASE_TONE_DBFS = 20 * Math.log10(BASE_TONE_PEAK);
const BIO_CAL_STORAGE_PREFIX = 'hearsmart_calibration_profile_v2_';
const VALIDATION_STORAGE_PREFIX = 'hearsmart_validation_v1_';
const HARDWARE_PREFS_KEY = 'hearsmart_last_hardware_v1';

// Add laboratory-calibrated phone + transducer combinations here when measured.
const DEVICE_PROFILES = {};

function getDeviceProfileKey({ phoneModel, headphoneModel, connectionType }) {
  return [Platform.OS, phoneModel, headphoneModel, connectionType]
    .map((value) => String(value || 'unknown').trim().toLowerCase().replace(/[^a-zA-Z0-9]/g, '_'))
    .join('__');
}

function isCompleteFrequencyMap(map) {
  return PURE_TONE_FREQUENCIES.every((frequency) => Number.isFinite(map?.[frequency]));
}

function isValidDeviceProfile(profile) {
  if (!profile || !Number.isFinite(profile.systemVolume) || profile.systemVolume <= 0 || profile.systemVolume > 1) return false;

  if (profile.type === 'acoustic') {
    if (!profile.validated) return false;
    for (const frequency of PURE_TONE_FREQUENCIES) {
      const spl = profile?.splAtZeroDbfs?.[frequency];
      const retspl = profile?.retsplDb?.[frequency];
      const maxSafe = profile?.maxSafeDbHl?.[frequency];
      if (!Number.isFinite(spl) || !Number.isFinite(retspl) || !Number.isFinite(maxSafe)) return false;
    }
    return true;
  }

  if (profile.type === 'biological') {
    return isCompleteFrequencyMap(profile?.thresholdDbfs?.right) &&
      isCompleteFrequencyMap(profile?.thresholdDbfs?.left);
  }

  return false;
}

function lookupDeviceProfile(key) {
  const profile = DEVICE_PROFILES[key];
  if (!profile) return null;
  const normalized = { ...profile, type: profile.type || 'acoustic' };
  return isValidDeviceProfile(normalized) ? normalized : null;
}

function calibrationMethodLabel(profile) {
  if (profile?.type === 'acoustic') return 'Acoustic laboratory profile';
  if (profile?.type === 'biological') {
    const clinicalSessions = Number(profile.clinicalAnchorSessions || profile.clinicalReferenceCount || 0);
    return clinicalSessions > 0 ? 'Clinically anchored biological calibration' : 'Biological reference calibration';
  }
  return 'No calibration profile';
}

function profileConfidenceLabel(profile) {
  if (profile?.type === 'acoustic') return 'HIGH — externally measured acoustic profile';
  if (profile?.type === 'biological') {
    const n = Number(profile.referenceCount || 1);
    const clinicalSessions = Number(profile.clinicalAnchorSessions || profile.clinicalReferenceCount || 0);
    const coverage = profileClinicalCoverage(profile);
    if (clinicalSessions >= 5 && coverage.anchoredPoints === 16) {
      return `CLINICALLY ANCHORED DEVELOPMENT PROFILE — ${clinicalSessions} paired sessions`;
    }
    if (clinicalSessions >= 1) {
      return `CLINICALLY ANCHORED RESEARCH PROFILE — ${clinicalSessions} paired session${clinicalSessions === 1 ? '' : 's'} · ${coverage.anchoredPoints}/16 points anchored`;
    }
    return n >= 5
      ? 'IMPROVED RESEARCH — multi-listener biological reference; no clinical anchor yet'
      : n >= 2
        ? 'PRELIMINARY — averaged biological references; no clinical anchor yet'
        : 'EXPERIMENTAL — single-listener biological reference; no clinical anchor yet';
  }
  return 'UNAVAILABLE';
}

function levelUnitLabel(profile) {
  return profile?.type === 'acoustic' ? 'dB HL' : 'estimated dB HL';
}

function profileDateLabel(profile) {
  const raw = profile?.measuredAt || profile?.createdAt;
  if (!raw) return 'Not recorded';
  try { return new Date(raw).toLocaleString('en-IN'); } catch (_) { return String(raw); }
}

const DBFS_FLOOR_WARNING_THRESHOLD = -85;

const WIRELESS_HEADPHONE_KEYWORDS = [
  'airpod', 'buds', 'bluetooth', 'wireless', 'beats', 'bose qc',
  'sony wh', 'sony wf', 'pixel buds', 'jabra', 'powerbeats',
];

function isLikelyWirelessHeadphone(description) {
  const text = (description || '').toLowerCase();
  return WIRELESS_HEADPHONE_KEYWORDS.some((keyword) => text.includes(keyword));
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

const INTERPOLATED_FREQUENCIES = new Set();

async function loadBiologicalProfile(profileKey) {
  try {
    const raw = await AsyncStorage.getItem(`${BIO_CAL_STORAGE_PREFIX}${profileKey}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidDeviceProfile(parsed) && parsed.type === 'biological' ? parsed : null;
  } catch (_) {
    return null;
  }
}

async function saveBiologicalProfile(profileKey, profile) {
  try {
    await AsyncStorage.setItem(`${BIO_CAL_STORAGE_PREFIX}${profileKey}`, JSON.stringify(profile));
    return true;
  } catch (_) {
    return false;
  }
}

async function deleteBiologicalProfile(profileKey) {
  try {
    await AsyncStorage.removeItem(`${BIO_CAL_STORAGE_PREFIX}${profileKey}`);
    return true;
  } catch (_) {
    return false;
  }
}

function emptyClinicalThresholdMap() {
  return {
    right: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, ''])),
    left: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, ''])),
  };
}

function parsedClinicalThresholds(input) {
  const output = { right: {}, left: {} };
  for (const ear of ['right', 'left']) {
    for (const frequency of PURE_TONE_FREQUENCIES) {
      const raw = input?.[ear]?.[frequency];
      if (raw === '' || raw == null) continue;
      const value = Number(raw);
      if (Number.isFinite(value) && value >= -10 && value <= 120) {
        output[ear][frequency] = value;
      }
    }
  }
  return output;
}

function hasCompleteClinicalAudiogram(input) {
  const parsed = parsedClinicalThresholds(input);
  return ['right', 'left'].every((ear) =>
    PURE_TONE_FREQUENCIES.every((frequency) => Number.isFinite(parsed?.[ear]?.[frequency])),
  );
}

function clinicalAudiogramEntryCount(input) {
  const parsed = parsedClinicalThresholds(input);
  return ['right', 'left'].reduce(
    (sum, ear) => sum + PURE_TONE_FREQUENCIES.filter((frequency) => Number.isFinite(parsed?.[ear]?.[frequency])).length,
    0,
  );
}

function clinicalPtaFromMap(map) {
  const values = [500, 1000, 2000].map((frequency) => map?.[frequency]);
  if (values.some((value) => !Number.isFinite(value))) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function makePerEarFrequencyMap(initialValue = 0) {
  return {
    right: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, initialValue])),
    left: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, initialValue])),
  };
}

function ensureClinicalAnchorCounts(profile) {
  const output = makePerEarFrequencyMap(0);
  for (const ear of ['right', 'left']) {
    for (const frequency of PURE_TONE_FREQUENCIES) {
      const value = Number(profile?.clinicalAnchorCounts?.[ear]?.[frequency]);
      output[ear][frequency] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    }
  }
  return output;
}

function profileClinicalCoverage(profile) {
  if (!profile || profile.type !== 'biological') return { anchoredPoints: 0, minPerPoint: 0 };
  const counts = ensureClinicalAnchorCounts(profile);
  const values = [];
  for (const ear of ['right', 'left']) {
    for (const frequency of PURE_TONE_FREQUENCIES) values.push(counts[ear][frequency]);
  }
  return {
    anchoredPoints: values.filter((value) => value > 0).length,
    minPerPoint: values.length ? Math.min(...values) : 0,
  };
}

async function saveValidationRecord(profileKey, record) {
  try {
    const key = `${VALIDATION_STORAGE_PREFIX}${profileKey}`;
    const raw = await AsyncStorage.getItem(key);
    const current = raw ? JSON.parse(raw) : [];
    const next = Array.isArray(current) ? [...current.slice(-49), record] : [record];
    await AsyncStorage.setItem(key, JSON.stringify(next));
    return true;
  } catch (_) {
    return false;
  }
}

function thresholdResult(db, floorLimited = false) {
  return { kind: 'threshold', db, floorLimited };
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
      shortLabel: 'Normal',
      label: 'Within normal air-conduction range',
      color: '#059669',
      recommendation: 'Repeat testing periodically or sooner if symptoms develop.',
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
  return Math.abs(initial - retest) > 5 ? Math.min(initial, retest) : initial;
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

function countFloorLimitedResults(earResults = {}) {
  return Object.values(earResults).filter(
    (result) => result?.kind === 'threshold' && result.floorLimited,
  ).length;
}

function getStepsForEar(ear, earResults = {}) {
  if (ear === 'left') {
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
    return db == null ? null : thresholdResult(db);
  }

  return earResults?.[String(frequency)] ?? null;
}

function computeClinicalPTA(earResults) {
  const values = [
    resultDb(earResults?.['500']),
    getAccepted1000Db(earResults),
    resultDb(earResults?.['2000']),
  ];
  if (values.some((value) => value == null)) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function computeFourFrequencyPTA(earResults) {
  const values = [
    resultDb(earResults?.['500']),
    getAccepted1000Db(earResults),
    resultDb(earResults?.['2000']),
    resultDb(earResults?.['4000']),
  ];
  if (values.some((value) => value == null)) return null;
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10;
}

function computeClinicalComparison(thresholds, clinicalInput) {
  const clinical = parsedClinicalThresholds(clinicalInput);
  const rows = [];
  for (const ear of ['right', 'left']) {
    for (const frequency of PURE_TONE_FREQUENCIES) {
      const appResult = acceptedResultForFrequency(thresholds?.[ear] || {}, frequency);
      const appDb = resultDb(appResult);
      const clinicalDb = clinical?.[ear]?.[frequency];
      if (!Number.isFinite(appDb) || !Number.isFinite(clinicalDb)) continue;
      rows.push({ ear, frequency, appDb, clinicalDb, errorDb: appDb - clinicalDb });
    }
  }
  if (!rows.length) return null;
  const absoluteErrors = rows.map((row) => Math.abs(row.errorDb));
  const errors = rows.map((row) => row.errorDb);
  const mae = absoluteErrors.reduce((sum, value) => sum + value, 0) / absoluteErrors.length;
  const bias = errors.reduce((sum, value) => sum + value, 0) / errors.length;
  const within5 = 100 * absoluteErrors.filter((value) => value <= 5).length / absoluteErrors.length;
  const within10 = 100 * absoluteErrors.filter((value) => value <= 10).length / absoluteErrors.length;
  return {
    rows,
    mae: Math.round(mae * 10) / 10,
    bias: Math.round(bias * 10) / 10,
    within5: Math.round(within5),
    within10: Math.round(within10),
  };
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
        return `Bilateral hearing within the app's normal air-conduction range (${caveat}).`;
      }
      return `Bilateral ${rightClass.shortLabel.toLowerCase()} degree hearing loss pattern on air-conduction testing (${caveat}).`;
    }
    return `Asymmetric air-conduction hearing threshold pattern — Right: ${rightClass.shortLabel}, Left: ${leftClass.shortLabel} (${caveat}).`;
  }

  const knownSide = rightPta != null ? 'Right' : 'Left';
  const cls = rightPta != null ? rightClass : leftClass;
  return `${knownSide} ear: ${cls.shortLabel.toLowerCase()} degree hearing loss pattern on air-conduction testing; opposite ear incomplete (${caveat}).`;
}

function dbHLToAmplitude(dbHL, frequencyHz, profile, ear = 'right') {
  if (!isValidDeviceProfile(profile)) {
    throw new Error('A complete calibration profile is required for estimated dB HL playback.');
  }

  let requestedDbfs;
  let targetSpl = null;
  if (profile.type === 'acoustic') {
    const splAtZeroDbfs = profile.splAtZeroDbfs[frequencyHz];
    const retsplDb = profile.retsplDb[frequencyHz];
    if (!Number.isFinite(splAtZeroDbfs) || !Number.isFinite(retsplDb)) {
      throw new Error(`Acoustic profile is incomplete at ${frequencyHz} Hz.`);
    }
    targetSpl = dbHL + retsplDb;
    requestedDbfs = targetSpl - splAtZeroDbfs;
  } else {
    const zeroDbfs = profile?.thresholdDbfs?.[ear]?.[frequencyHz];
    if (!Number.isFinite(zeroDbfs)) {
      throw new Error(`Biological calibration is incomplete for the ${ear} ear at ${frequencyHz} Hz.`);
    }
    requestedDbfs = zeroDbfs + dbHL;
  }

  const appliedDbfs = Math.min(BASE_TONE_DBFS, requestedDbfs);
  const playbackGain = Math.max(0, Math.min(1, Math.pow(10, (appliedDbfs - BASE_TONE_DBFS) / 20)));
  const maxDbHl = maxPlayableDbHl(profile, ear, frequencyHz);

  return {
    amplitude: playbackGain,
    playbackGain,
    targetSpl,
    dBFS: appliedDbfs,
    requestedDbfs,
    clipped: requestedDbfs > BASE_TONE_DBFS,
    maxDbHl,
  };
}

function maxPlayableDbHl(profile, ear, frequencyHz) {
  if (!isValidDeviceProfile(profile)) return MIN_DB;
  let rawMax;
  if (profile.type === 'acoustic') {
    rawMax = Math.min(
      profile.splAtZeroDbfs[frequencyHz] + BASE_TONE_DBFS - profile.retsplDb[frequencyHz],
      profile.maxSafeDbHl[frequencyHz],
      MAX_DB,
    );
  } else {
    rawMax = Math.min(
      BASE_TONE_DBFS - profile.thresholdDbfs[ear][frequencyHz],
      MAX_BIO_DB,
    );
  }
  if (!Number.isFinite(rawMax)) return MIN_DB;
  return Math.max(MIN_DB, Math.floor(rawMax / 5) * 5);
}

function volumeLabelForResult(freq, result, profile, ear = 'right') {
  if (!result) return null;
  const db = result.kind === 'no_response' ? result.maxDb : result.db;
  try {
    const info = dbHLToAmplitude(db, freq, profile, ear);
    if (profile.type === 'acoustic') {
      return `${info.dBFS.toFixed(1)} dBFS · target ${info.targetSpl.toFixed(1)} dB SPL`;
    }
    return `${info.dBFS.toFixed(1)} dBFS · biological reference`;
  } catch (_) {
    return null;
  }
}

function writePcm16(view, offset, signedValue) {
  view.setInt16(offset, signedValue, true);
}

function buildStereoWav(
  frequencyHz,
  dbHL,
  ear,
  profile,
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

  const amplitude = BASE_TONE_PEAK;

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

function buildFixedStereoToneWav(frequencyHz, ear, durationSec = 0.9, toneRms = 0.035) {
  if (ear !== 'left' && ear !== 'right') throw new Error('Ear must be "left" or "right".');

  const sampleRate = 44100;
  const channels = 2;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const numSamples = Math.floor(sampleRate * durationSec);
  const rampSamples = Math.floor(sampleRate * (RAMP_MS / 1000));
  const dataSize = numSamples * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const peak = Math.min(0.12, Math.max(0.005, toneRms * Math.SQRT2));

  const writeString = (offset, text) => {
    for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
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

  const max16 = 0x7fff;
  for (let index = 0; index < numSamples; index += 1) {
    let envelope = 1;
    if (index < rampSamples) {
      envelope = 0.5 * (1 - Math.cos((Math.PI * index) / rampSamples));
    } else if (index >= numSamples - rampSamples) {
      const remaining = numSamples - 1 - index;
      envelope = 0.5 * (1 - Math.cos((Math.PI * remaining) / rampSamples));
    }
    const sample = Math.round(
      peak * envelope * Math.sin((2 * Math.PI * frequencyHz * index) / sampleRate) * max16,
    );
    const offset = 44 + index * blockAlign;
    writePcm16(view, offset, ear === 'left' ? sample : 0);
    writePcm16(view, offset + bytesPerSample, ear === 'right' ? sample : 0);
  }

  return encodeBase64(buffer);
}

async function ensureToneFile(cacheKey, base64) {
  const safeName = `hearsmart_${String(cacheKey).replace(/[^a-zA-Z0-9]/g, '_')}.wav`;
  const file = new File(Paths.cache, safeName);
  if (!file.exists) {
    file.create();
    file.write(new Uint8Array(decodeBase64(base64)));
  }
  return file.uri;
}

function disposeAudioPlayer(player) {
  if (!player) return;
  try {
    player.pause?.();
  } catch (_) {}
  try {
    if (typeof player.release === 'function') player.release();
    else player.remove?.();
  } catch (_) {}
}

async function sharePdf(html, title = 'HearSmart report') {
  const { uri } = await Print.printToFileAsync({ html, base64: false });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, {
      mimeType: 'application/pdf',
      dialogTitle: title,
      UTI: 'com.adobe.pdf',
    });
    return uri;
  }
  await Share.share({
    title,
    message: `HearSmart generated the PDF report at ${uri}`,
  });
  return uri;
}


function EarAudiogram({ ear, results }) {
  const { width: windowWidth } = useWindowDimensions();
  const width = Math.max(300, Math.min(windowWidth - 48, 560));
  const height = 340;
  const padLeft = 42;
  const padRight = 16;
  const padTop = 26;
  const padBottom = 34;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
  const frequencies = PURE_TONE_FREQUENCIES;
  const dbLines = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
  const xFor = (frequency) => padLeft + (Math.log10(frequency / 250) / Math.log10(8000 / 250)) * plotWidth;
  const yFor = (db) => padTop + ((db - MIN_DB) / (AUDIOGRAM_DISPLAY_MAX_DB - MIN_DB)) * plotHeight;
  const points = frequencies.map((frequency) => {
    const result = acceptedResultForFrequency(results, frequency);
    if (!result) return null;
    const isNr = result.kind === 'no_response';
    const db = isNr ? result.maxDb : result.db;
    return { frequency, x: xFor(frequency), y: yFor(db), isNr };
  });
  const connected = points.filter((point) => point && !point.isNr);
  const path = connected.length >= 2
    ? connected.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
    : '';

  return (
    <Svg width={width} height={height}>
      <SvgText x={width / 2} y="15" fontSize="12" fontWeight="700" fill={color} textAnchor="middle">
        {ear === 'right' ? 'RIGHT EAR (O)' : 'LEFT EAR (X)'}
      </SvgText>
      {frequencies.map((frequency) => (
        <React.Fragment key={`fx-${ear}-${frequency}`}>
          <Line x1={xFor(frequency)} y1={padTop} x2={xFor(frequency)} y2={height - padBottom} stroke="#D6DEE8" strokeWidth="1" />
          <SvgText x={xFor(frequency)} y={height - 12} fontSize="9" fill="#64748B" textAnchor="middle">
            {frequency >= 1000 ? `${frequency / 1000}k` : frequency}
          </SvgText>
        </React.Fragment>
      ))}
      {dbLines.map((db) => (
        <React.Fragment key={`db-${ear}-${db}`}>
          <Line x1={padLeft} y1={yFor(db)} x2={width - padRight} y2={yFor(db)} stroke="#D6DEE8" strokeWidth="1" />
          <SvgText x={padLeft - 6} y={yFor(db) + 3} fontSize="9" fill="#64748B" textAnchor="end">{db}</SvgText>
        </React.Fragment>
      ))}
      {path ? <Path d={path} stroke={color} strokeWidth="2" fill="none" /> : null}
      {points.map((point) => {
        if (!point) return null;
        if (ear === 'right') {
          return (
            <React.Fragment key={`mark-${ear}-${point.frequency}`}>
              <Circle cx={point.x} cy={point.y} r="6" fill="#FFFFFF" stroke={color} strokeWidth="2" />
              {point.isNr ? <><Line x1={point.x} y1={point.y + 7} x2={point.x} y2={point.y + 17} stroke={color} strokeWidth="2" /><Path d={`M ${point.x - 4} ${point.y + 13} L ${point.x} ${point.y + 18} L ${point.x + 4} ${point.y + 13}`} stroke={color} strokeWidth="2" fill="none" /></> : null}
            </React.Fragment>
          );
        }
        return (
          <React.Fragment key={`mark-${ear}-${point.frequency}`}>
            <Line x1={point.x - 6} y1={point.y - 6} x2={point.x + 6} y2={point.y + 6} stroke={color} strokeWidth="2" />
            <Line x1={point.x + 6} y1={point.y - 6} x2={point.x - 6} y2={point.y + 6} stroke={color} strokeWidth="2" />
            {point.isNr ? <><Line x1={point.x} y1={point.y + 8} x2={point.x} y2={point.y + 18} stroke={color} strokeWidth="2" /><Path d={`M ${point.x - 4} ${point.y + 14} L ${point.x} ${point.y + 19} L ${point.x + 4} ${point.y + 14}`} stroke={color} strokeWidth="2" fill="none" /></> : null}
          </React.Fragment>
        );
      })}
      <SvgText x="10" y={height / 2} fontSize="9" fill="#64748B" textAnchor="middle" transform={`rotate(-90 10 ${height / 2})`}>Hearing level (dB HL)</SvgText>
    </Svg>
  );
}

function buildEarAudiogramSvg(ear, results) {
  const width = 260;
  const height = 300;
  const padLeft = 40;
  const padRight = 14;
  const padTop = 28;
  const padBottom = 30;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const frequencies = [250, 500, 1000, 2000, 3000, 4000, 6000, 8000];
  const dbLines = [-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
  const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
  const title = ear === 'right' ? 'RIGHT (O)' : 'LEFT (X)';

  const xFor = (frequency) =>
    padLeft + (Math.log10(frequency / 250) / Math.log10(8000 / 250)) * plotWidth;
  const yFor = (db) => padTop + ((db - MIN_DB) / (AUDIOGRAM_DISPLAY_MAX_DB - MIN_DB)) * plotHeight;

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
        <line x1="${padLeft}" y1="${yFor(db)}" x2="${width - padRight}" y2="${yFor(db)}" stroke="#d7dee7" stroke-width="0.8"/>
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
      ${grid}
      ${path ? `<path d="${path}" stroke="${color}" stroke-width="1.6" fill="none"/>` : ''}
      ${marks}
    </svg>
  `;
}


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


function VolumeGate({ systemVolume, volumeLoading, volumeReady, targetVolume, onSetTargetVolume }) {
  const targetPercent = Math.round(targetVolume * 100);
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
            {volumeReady ? `✓ ${targetPercent}% confirmed` : `Set volume to ${targetPercent}%`}
          </Text>
          <TouchableOpacity style={styles.secondaryButton} onPress={onSetTargetVolume}>
            <Text style={styles.secondaryButtonText}>Set volume to {targetPercent}%</Text>
          </TouchableOpacity>
          <Text style={styles.smallNote}>
            Keep system volume unchanged during the test. Trial-to-trial level changes are generated digitally.
          </Text>
        </>
      )}
    </View>
  );
}

function VolumeBlockedOverlay({ volumeBlocked, systemVolume, targetVolume, onSetTargetVolume }) {
  if (!volumeBlocked) return null;
  const targetPercent = Math.round(targetVolume * 100);
  return (
    <View style={styles.blockOverlay}>
      <View style={styles.blockCard}>
        <Text style={styles.blockTitle}>Volume changed — test paused</Text>
        <Text style={styles.blockBody}>
          The interrupted presentation was cancelled and will not count. Restore the required system volume before continuing.
        </Text>
        <Text style={styles.blockVolume}>
          Current: {systemVolume == null ? 'unknown' : `${Math.round(systemVolume * 100)}%`} · Required: {targetPercent}%
        </Text>
        <TouchableOpacity style={styles.primaryButton} onPress={onSetTargetVolume}>
          <Text style={styles.primaryButtonText}>Restore {targetPercent}% and resume</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function EarResults({ ear, results, pta, classification, deviceProfile }) {
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
      <Text style={styles.dbUnit}>PTA 500/1k/2k · {levelUnitLabel(deviceProfile)}</Text>
      {floorCount > 0 ? (
        <View style={styles.reliabilityBox}>
          <Text style={{ color: '#D97706', fontWeight: '700', textAlign: 'center' }}>
            ⚠ {floorCount} threshold{floorCount > 1 ? 's' : ''} on this ear required extremely low native playback gain. Very low gain can become device-dependent, so treat those points with extra caution.
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
              ? '✓ 1 kHz repeatability check is within 5 dB'
              : '⚠ 1 kHz retest differed by more than 5 dB; the lower 1 kHz threshold is retained and 2 kHz is rechecked'}
          </Text>
        </View>
      ) : null}

      <View style={{ width: '100%', marginTop: 12 }}>
        {steps
          .filter((item) => results[item.id])
          .map((item) => {
            const result = results[item.id];
            return (
              <View key={item.id} style={styles.resultRow}>
                <Text style={styles.resultFrequency}>
                  {formatFrequency(item.freq)}
                  {item.id.includes('retest') || item.id.includes('recheck') ? ' ↺' : ''}
                  {INTERPOLATED_FREQUENCIES.has(item.freq) ? ' *' : ''}
                </Text>
                <Text style={styles.resultValue}>{formatResult(result)}</Text>
              </View>
            );
          })}
      </View>
    </View>
  );
}


export default function App() {
  const [phase, setPhase] = useState('setup');
  const phaseRef = useRef('setup');

  const [participantName, setParticipantName] = useState('');
  const [participantAge, setParticipantAge] = useState('');
  const [participantSex, setParticipantSex] = useState(null);
  const [referredBy, setReferredBy] = useState('');
  const [chiefComplaint, setChiefComplaint] = useState('');
  const [testId, setTestId] = useState('');
  const [phoneModel, setPhoneModel] = useState(() => Device.modelName ?? '');
  const [headphoneDescription, setHeadphoneDescription] = useState('');
  const [connectionType, setConnectionType] = useState('wired');
  const [headphonesConfirmed, setHeadphonesConfirmed] = useState(false);
  const [quietRoomConfirmed, setQuietRoomConfirmed] = useState(false);

  const [testMode, setTestMode] = useState(null);
  const [deviceProfile, setDeviceProfile] = useState(null);


  const [bioCalibrationData, setBioCalibrationData] = useState({ right: {}, left: {} });
  const bioCalibrationDataRef = useRef({ right: {}, left: {} });
  const [bioEar, setBioEar] = useState('right');
  const [bioFreqIndex, setBioFreqIndex] = useState(0);
  const [bioDbfs, setBioDbfs] = useState(BIO_CAL_START_DBFS);
  const bioDbfsRef = useRef(BIO_CAL_START_DBFS);
  const [bioResponseReady, setBioResponseReady] = useState(false);
  const [bioHistory, setBioHistory] = useState([]);
  const bioDirectionRef = useRef('initial');
  const bioHadDescentRef = useRef(false);
  const bioAscendingWindowsRef = useRef({});
  const bioMaxMissesRef = useRef(0);
  const [bioReferenceConfirmed, setBioReferenceConfirmed] = useState(false);
  const [bioMergeBaseProfile, setBioMergeBaseProfile] = useState(null);
  const [bioReferenceMode, setBioReferenceMode] = useState('clinical');
  const [bioClinicalThresholds, setBioClinicalThresholds] = useState(() => emptyClinicalThresholdMap());

  const [otoscopyStatus, setOtoscopyStatus] = useState(null);
  const [acuteEarSymptoms, setAcuteEarSymptoms] = useState(false);

  const [validationClinicalThresholds, setValidationClinicalThresholds] = useState(() => emptyClinicalThresholdMap());
  const [validationMessage, setValidationMessage] = useState(null);
  const [savingValidation, setSavingValidation] = useState(false);

  const [systemVolume, setSystemVolume] = useState(null);
  const [volumeLoading, setVolumeLoading] = useState(true);
  const [volumeBlocked, setVolumeBlocked] = useState(false);

  const [channelCheck, setChannelCheck] = useState({ right: false, left: false });
  const [channelCheckEar, setChannelCheckEar] = useState(null);
  const [channelResponseReady, setChannelResponseReady] = useState(false);

  const [currentEar, setCurrentEar] = useState(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [currentDb, setCurrentDb] = useState(DEFAULT_START_DB);
  const currentDbRef = useRef(DEFAULT_START_DB);
  const [practiceDb, setPracticeDb] = useState(30);
  const [practicePassed, setPracticePassed] = useState(false);
  const [tonePlayed, setTonePlayed] = useState(false);
  const [thresholds, setThresholds] = useState({ right: {}, left: {} });
  const thresholdsRef = useRef({ right: {}, left: {} });
  const [history, setHistory] = useState([]);
  const [thresholdBanner, setThresholdBanner] = useState(null);
  const [lastFeedback, setLastFeedback] = useState(null);
  const [ascendingWindowDisplay, setAscendingWindowDisplay] = useState([]);
  const [directionDisplay, setDirectionDisplay] = useState('initial');
  const [hadDescentDisplay, setHadDescentDisplay] = useState(false);
  const ascendingWindowsRef = useRef({});
  const directionRef = useRef('initial');
  const hadDescentRef = useRef(false);
  const maxMissesRef = useRef(0);

  const [isPlaying, setIsPlaying] = useState(false);
  const [exporting, setExporting] = useState(false);
  const playerRef = useRef(null);
  const playerSubscriptionRef = useRef(null);
  const playbackTokenRef = useRef(0);
  const playbackBusyRef = useRef(false);
  const toneCacheRef = useRef(new Map());
  const responseLockedRef = useRef(false);
  const transitionTimerRef = useRef(null);
  const feedbackTimerRef = useRef(null);
  const testStartedAtRef = useRef(null);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(HARDWARE_PREFS_KEY);
        if (!raw || !mounted) return;
        const parsed = JSON.parse(raw);
        if (!Device.modelName && parsed?.phoneModel) setPhoneModel(String(parsed.phoneModel));
        if (parsed?.headphoneDescription) setHeadphoneDescription(String(parsed.headphoneDescription));
        if (parsed?.connectionType === 'wired' || parsed?.connectionType === 'bluetooth') setConnectionType(parsed.connectionType);
      } catch (_) {}
    })();
    return () => { mounted = false; };
  }, []);

  const resolvedPhoneModel = String(Device.modelName || phoneModel || '').trim();

  const profileKey = useMemo(
    () => getDeviceProfileKey({
      phoneModel: resolvedPhoneModel,
      headphoneModel: headphoneDescription,
      connectionType,
    }),
    [resolvedPhoneModel, headphoneDescription, connectionType],
  );

  const matchedProfile = useMemo(() => lookupDeviceProfile(profileKey), [profileKey]);
  const targetVolume = deviceProfile?.systemVolume ?? matchedProfile?.systemVolume ?? DEFAULT_SYSTEM_VOLUME;
  const volumeReady =
    systemVolume != null && Math.abs(systemVolume - targetVolume) <= VOLUME_TOLERANCE;

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

  const stopSound = useCallback(async (preserveBusy = false) => {
    playbackTokenRef.current += 1;
    playerSubscriptionRef.current?.remove?.();
    playerSubscriptionRef.current = null;
    const player = playerRef.current;
    playerRef.current = null;
    disposeAudioPlayer(player);
    if (!preserveBusy) playbackBusyRef.current = false;
    setIsPlaying(false);
  }, []);

  const cancelPresentation = useCallback(async (preserveBusy = false) => {
    await stopSound(preserveBusy);
    setTonePlayed(false);
    setChannelResponseReady(false);
    setBioResponseReady(false);
    responseLockedRef.current = false;
  }, [stopSound]);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldRouteThroughEarpiece: false,
          shouldPlayInBackground: false,
          allowsRecording: false,
          interruptionMode: 'doNotMix',
        });
      } catch (error) {
        if (mounted) {
          Alert.alert('Audio setup failed', error?.message ?? 'Unable to configure the audio session.');
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;
    let subscription = null;

    (async () => {
      try {
        const initial = await VolumeManager.getVolume();
        if (!mounted) return;
        setSystemVolume(initial.volume);
        setVolumeLoading(false);
        subscription = VolumeManager.addVolumeListener((result) => {
          if (!mounted || typeof result?.volume !== 'number') return;
          setSystemVolume(result.volume);
        });
      } catch (error) {
        if (!mounted) return;
        setSystemVolume(null);
        setVolumeLoading(false);
        Alert.alert(
          'System-volume access unavailable',
          error?.message ?? 'Run HearSmart in a custom Expo development build; Expo Go does not include the native volume module.',
        );
      }
    })();

    return () => {
      mounted = false;
      subscription?.remove?.();
      clearTimers();
      stopSound();
    };
  }, [clearTimers, stopSound]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') cancelPresentation();
    });
    return () => subscription.remove();
  }, [cancelPresentation]);

  useEffect(() => {
    const protectedPhases = new Set([
      'channel_check',
      'calibration_info',
      'biological_calibration',
      'ear_intro',
      'familiarize',
      'testing',
      'validation',
    ]);
    if (!protectedPhases.has(phaseRef.current) || systemVolume == null) return;
    const offTarget = Math.abs(systemVolume - targetVolume) > VOLUME_TOLERANCE;
    if (offTarget) {
      setVolumeBlocked(true);
      cancelPresentation();
    } else {
      setVolumeBlocked(false);
    }
  }, [systemVolume, targetVolume, cancelPresentation]);

  async function setTargetVolume() {
    try {
      if (Platform.OS === 'android') {
        await VolumeManager.setVolume(targetVolume, {
          type: 'music',
          playSound: false,
          showUI: false,
        });
      } else {
        await VolumeManager.setVolume(targetVolume);
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      const verified = await VolumeManager.getVolume();
      setSystemVolume(verified.volume);
      const okay = Math.abs(verified.volume - targetVolume) <= VOLUME_TOLERANCE;
      setVolumeBlocked(!okay && phaseRef.current !== 'setup');
      if (!okay) {
        Alert.alert(
          'Volume not confirmed',
          `Set media volume to about ${Math.round(targetVolume * 100)}% and try again.`,
        );
      }
    } catch (error) {
      Alert.alert(
        'Could not set system volume',
        error?.message ?? `Set media volume manually to ${Math.round(targetVolume * 100)}%.`,
      );
    }
  }

  async function playGeneratedWav(base64, cacheKey, onFinished, playbackVolume = 1) {
    if (playbackBusyRef.current) return false;
    playbackBusyRef.current = true;
    await cancelPresentation(true);
    if (!volumeReady) {
      playbackBusyRef.current = false;
      setVolumeBlocked(phaseRef.current !== 'setup');
      Alert.alert(
        'Required volume not set',
        `Set system media volume to ${Math.round(targetVolume * 100)}% before playing a test sound.`,
      );
      return false;
    }

    setIsPlaying(true);
    try {
      await setIsAudioActiveAsync(true);
      const uri = await ensureToneFile(cacheKey, base64);
      const token = playbackTokenRef.current + 1;
      playbackTokenRef.current = token;
      const player = createAudioPlayer(uri);
      player.volume = Math.max(0, Math.min(1, playbackVolume));
      playerRef.current = player;

      let subscription = null;
      const releasePlayer = () => {
        subscription?.remove?.();
        if (playerSubscriptionRef.current === subscription) playerSubscriptionRef.current = null;
        disposeAudioPlayer(player);
        if (playerRef.current === player) playerRef.current = null;
        playbackBusyRef.current = false;
        setIsPlaying(false);
      };

      subscription = player.addListener('playbackStatusUpdate', (status) => {
        if (token !== playbackTokenRef.current) return;
        if (status.error) {
          releasePlayer();
          Alert.alert('Audio playback failed', String(status.error));
          return;
        }
        if (status.didJustFinish) {
          releasePlayer();
          onFinished?.();
        }
      });
      playerSubscriptionRef.current = subscription;
      player.play();
      return true;
    } catch (error) {
      playbackBusyRef.current = false;
      await stopSound();
      Alert.alert('Audio playback failed', error?.message ?? 'Unable to play the generated WAV file.');
      return false;
    }
  }

  async function playChannelCheck(ear) {
    setChannelCheckEar(ear);
    const cacheKey = `${APP_VERSION}:channel:${ear}`;
    const wav = buildFixedStereoToneWav(1000, ear, 0.85, 0.012);
    await playGeneratedWav(wav, cacheKey, () => setChannelResponseReady(true));
  }

  async function playPureTone(frequencyHz, dbHL, ear) {
    if (!isValidDeviceProfile(deviceProfile)) {
      Alert.alert(
        'Calibration required',
        'This phone/headphone setup needs a complete acoustic or biological reference profile before estimated dB HL testing can begin.',
      );
      return;
    }
    try {
      const info = dbHLToAmplitude(dbHL, frequencyHz, deviceProfile, ear);
      if (info.clipped) {
        Alert.alert(
          'Device output ceiling reached',
          `This setup cannot reproduce ${dbHL} dB HL at ${formatFrequency(frequencyHz)} without exceeding the calibrated digital range. The highest supported level is about ${info.maxDbHl} dB HL.`,
        );
        return;
      }
      const cacheKey = `${APP_VERSION}:purebase:${frequencyHz}:${ear}`;
      let wav = toneCacheRef.current.get(cacheKey);
      if (!wav) {
        wav = buildStereoWav(frequencyHz, 0, ear, deviceProfile);
        if (toneCacheRef.current.size > 64) {
          const firstKey = toneCacheRef.current.keys().next().value;
          toneCacheRef.current.delete(firstKey);
        }
        toneCacheRef.current.set(cacheKey, wav);
      }
      await playGeneratedWav(wav, cacheKey, () => {
        setTonePlayed(true);
        responseLockedRef.current = false;
      }, info.playbackGain);
    } catch (error) {
      Alert.alert('Tone unavailable', error?.message ?? 'The requested level is outside the current calibration profile.');
    }
  }

  function resetBioAlgorithm(startDbfs = BIO_CAL_START_DBFS) {
    bioDbfsRef.current = startDbfs;
    bioDirectionRef.current = 'initial';
    bioHadDescentRef.current = false;
    bioAscendingWindowsRef.current = {};
    bioMaxMissesRef.current = 0;
    responseLockedRef.current = false;
    setBioDbfs(startDbfs);
    setBioHistory([]);
    setBioResponseReady(false);
  }

  function startBiologicalCalibration() {
    const empty = { right: {}, left: {} };
    bioCalibrationDataRef.current = empty;
    setBioCalibrationData(empty);
    setBioEar('right');
    setBioFreqIndex(0);
    resetBioAlgorithm(BIO_CAL_START_DBFS);
    setPhase('biological_calibration');
  }

  async function playBiologicalCalibrationTone() {
    const frequency = BIO_CAL_ORDER[bioFreqIndex];
    const dbfs = bioDbfsRef.current;
    const playbackGain = Math.max(0, Math.min(1, Math.pow(10, (dbfs - BASE_TONE_DBFS) / 20)));
    const cacheKey = `${APP_VERSION}:biocal:${frequency}:${bioEar}`;
    let wav = toneCacheRef.current.get(cacheKey);
    if (!wav) {
      wav = buildStereoWav(frequency, 0, bioEar, {
        type: 'biological',
        systemVolume: DEFAULT_SYSTEM_VOLUME,
        thresholdDbfs: {
          right: Object.fromEntries(PURE_TONE_FREQUENCIES.map((f) => [f, -60])),
          left: Object.fromEntries(PURE_TONE_FREQUENCIES.map((f) => [f, -60])),
        },
      });
      toneCacheRef.current.set(cacheKey, wav);
    }
    await playGeneratedWav(wav, cacheKey, () => {
      setBioResponseReady(true);
      responseLockedRef.current = false;
    }, playbackGain);
  }

  function addBioAscendingTrial(dbfs, heard) {
    const key = String(dbfs);
    const previous = bioAscendingWindowsRef.current[key] ?? [];
    const next = [...previous, heard].slice(-3);
    bioAscendingWindowsRef.current[key] = next;
    return next;
  }

  async function completeBiologicalCalibration(finalData) {
    const previous = bioMergeBaseProfile?.type === 'biological' ? bioMergeBaseProfile : null;
    const previousCount = Math.max(0, Number(previous?.referenceCount || 0));
    const clinicalKnown = bioReferenceMode === 'clinical' && hasCompleteClinicalAudiogram(bioClinicalThresholds);
    const clinical = parsedClinicalThresholds(bioClinicalThresholds);

    const sessionZeroReference = { right: {}, left: {} };
    for (const ear of ['right', 'left']) {
      for (const frequency of PURE_TONE_FREQUENCIES) {
        const measuredThresholdDbfs = Number(finalData?.[ear]?.[frequency]);
        const knownClinicalDbHl = clinicalKnown ? Number(clinical?.[ear]?.[frequency]) : 0;
        sessionZeroReference[ear][frequency] = Math.round((measuredThresholdDbfs - knownClinicalDbHl) * 10) / 10;
      }
    }

    const previousClinicalSessions = Math.max(0, Number(previous?.clinicalAnchorSessions || previous?.clinicalReferenceCount || 0));
    const clinicalAnchorCounts = ensureClinicalAnchorCounts(previous);
    const clinicalAnchorMeanDbfs = {
      right: { ...(previous?.clinicalAnchorMeanDbfs?.right || {}) },
      left: { ...(previous?.clinicalAnchorMeanDbfs?.left || {}) },
    };

    let combinedData = previous?.thresholdDbfs
      ? { right: { ...previous.thresholdDbfs.right }, left: { ...previous.thresholdDbfs.left } }
      : { right: {}, left: {} };

    if (clinicalKnown) {
      for (const ear of ['right', 'left']) {
        for (const frequency of PURE_TONE_FREQUENCIES) {
          const n = clinicalAnchorCounts[ear][frequency];
          const oldMean = Number(clinicalAnchorMeanDbfs?.[ear]?.[frequency]);
          const newValue = sessionZeroReference[ear][frequency];
          const updatedMean = n > 0 && Number.isFinite(oldMean)
            ? ((oldMean * n) + newValue) / (n + 1)
            : newValue;
          clinicalAnchorMeanDbfs[ear][frequency] = Math.round(updatedMean * 10) / 10;
          clinicalAnchorCounts[ear][frequency] = n + 1;
          combinedData[ear][frequency] = clinicalAnchorMeanDbfs[ear][frequency];
        }
      }
    } else {
      const coverage = profileClinicalCoverage(previous);
      if (!previous || coverage.anchoredPoints === 0) {
        if (!previous || previousCount === 0) {
          combinedData = sessionZeroReference;
        } else {
          for (const ear of ['right', 'left']) {
            for (const frequency of PURE_TONE_FREQUENCIES) {
              combinedData[ear][frequency] = Math.round((
                ((previous.thresholdDbfs[ear][frequency] * previousCount) + sessionZeroReference[ear][frequency]) /
                (previousCount + 1)
              ) * 10) / 10;
            }
          }
        }
      }
      // Once a frequency has a clinical anchor, an unverified reference is never allowed
      // to move that absolute dB-HL zero. It can still be recorded as a research session.
    }

    const profile = {
      type: 'biological',
      profileVersion: 2,
      validated: false,
      systemVolume: DEFAULT_SYSTEM_VOLUME,
      thresholdDbfs: combinedData,
      referenceCount: previousCount + 1,
      unverifiedReferenceCount: Number(previous?.unverifiedReferenceCount || 0) + (clinicalKnown ? 0 : 1),
      clinicalAnchorSessions: previousClinicalSessions + (clinicalKnown ? 1 : 0),
      clinicalAnchorCounts,
      clinicalAnchorMeanDbfs,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      phoneModel: resolvedPhoneModel,
      headphoneModel: headphoneDescription.trim(),
      connectionType,
      method: clinicalKnown
        ? `${previousCount + 1} hardware reference session${previousCount + 1 === 1 ? '' : 's'}; latest session anchored to a complete conventional audiogram; 10-down/5-up ascending threshold search`
        : `${previousCount + 1} hardware reference session${previousCount + 1 === 1 ? '' : 's'}; latest session had no clinical audiogram and therefore does not override clinically anchored frequencies`,
    };

    const saved = await saveBiologicalProfile(profileKey, profile);
    if (!saved) {
      Alert.alert('Calibration save warning', 'Calibration finished, but the profile could not be saved permanently. It will still be used for this session.');
    }
    setDeviceProfile(profile);
    setBioMergeBaseProfile(null);
    setBioClinicalThresholds(emptyClinicalThresholdMap());
    setTestMode('biological_pure_tone');
    setChannelCheck({ right: false, left: false });
    setChannelCheckEar(null);
    setChannelResponseReady(false);
    setPhase('channel_check');
  }

  function finishBioFrequency(thresholdDbfs) {
    const frequency = BIO_CAL_ORDER[bioFreqIndex];
    const nextData = {
      ...bioCalibrationDataRef.current,
      [bioEar]: {
        ...bioCalibrationDataRef.current[bioEar],
        [frequency]: Math.round(thresholdDbfs),
      },
    };
    bioCalibrationDataRef.current = nextData;
    setBioCalibrationData(nextData);

    const nextIndex = bioFreqIndex + 1;
    if (nextIndex < BIO_CAL_ORDER.length) {
      setBioFreqIndex(nextIndex);
      resetBioAlgorithm(BIO_CAL_START_DBFS);
      return;
    }

    if (bioEar === 'right') {
      setBioEar('left');
      setBioFreqIndex(0);
      resetBioAlgorithm(BIO_CAL_START_DBFS);
      return;
    }

    completeBiologicalCalibration(nextData);
  }

  function handleBioResponse(heard) {
    if (!bioResponseReady || isPlaying || responseLockedRef.current) return;
    responseLockedRef.current = true;
    setBioResponseReady(false);

    const dbfs = bioDbfsRef.current;
    const arrivedAscending = bioDirectionRef.current === 'asc';
    const hadDescent = bioHadDescentRef.current;
    const validAscending = (arrivedAscending && hadDescent) || (dbfs === BIO_CAL_MIN_DBFS && hadDescent);
    setBioHistory((previous) => [...previous, { dbfs, heard, validAscending }]);

    if (!heard && dbfs >= Math.floor(BASE_TONE_DBFS)) {
      bioMaxMissesRef.current += 1;
      if (bioMaxMissesRef.current >= 2) {
        responseLockedRef.current = false;
        Alert.alert(
          'Reference calibration failed at this frequency',
          'The reference listener did not detect the tone near the maximum digital presentation. Check the headphones, routing, system volume, and listener eligibility before continuing.',
        );
        return;
      }
      responseLockedRef.current = false;
      return;
    }
    bioMaxMissesRef.current = 0;

    if (validAscending) {
      const window = addBioAscendingTrial(dbfs, heard);
      if (window.filter(Boolean).length >= 2) {
        finishBioFrequency(dbfs);
        return;
      }
    }

    let next;
    if (!hadDescent) {
      if (heard) {
        next = Math.max(BIO_CAL_MIN_DBFS, dbfs - 10);
        bioDirectionRef.current = 'desc';
        bioHadDescentRef.current = true;
      } else {
        next = Math.min(Math.floor(BASE_TONE_DBFS), dbfs + 10);
        bioDirectionRef.current = 'asc';
      }
    } else if (heard) {
      next = Math.max(BIO_CAL_MIN_DBFS, dbfs - 10);
      bioDirectionRef.current = 'desc';
    } else {
      next = Math.min(Math.floor(BASE_TONE_DBFS), dbfs + 5);
      bioDirectionRef.current = 'asc';
    }

    bioDbfsRef.current = next;
    setBioDbfs(next);
    responseLockedRef.current = false;
  }

  function resetPureAlgorithm(startDb = DEFAULT_START_DB) {
    ascendingWindowsRef.current = {};
    directionRef.current = 'initial';
    hadDescentRef.current = false;
    currentDbRef.current = startDb;
    maxMissesRef.current = 0;
    responseLockedRef.current = false;
    setCurrentDb(startDb);
    setAscendingWindowDisplay([]);
    setDirectionDisplay('initial');
    setHadDescentDisplay(false);
    setHistory([]);
    setTonePlayed(false);
    setLastFeedback(null);
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

  function beginPureEar(ear) {
    setCurrentEar(ear);
    const maxAt1k = isValidDeviceProfile(deviceProfile) ? maxPlayableDbHl(deviceProfile, ear, 1000) : 30;
    setPracticeDb(Math.min(30, maxAt1k));
    setPracticePassed(false);
    setTonePlayed(false);
    setPhase('ear_intro');
  }

  function beginTestingCurrentEar() {
    if (!isValidDeviceProfile(deviceProfile)) return;
    const maxAt1k = maxPlayableDbHl(deviceProfile, currentEar, 1000);
    let expectedDb;
    if (currentEar === 'right') {
      expectedDb = practiceDb;
    } else {
      expectedDb = getAccepted1000Db(thresholdsRef.current.right);
      if (!Number.isFinite(expectedDb)) expectedDb = 20;
    }
    // Start 10 dB below the best current estimate, then ascend in 5 dB steps.
    // This is faster than restarting every ear at 40 dB while preserving an ascending threshold search.
    const startDb = Math.max(MIN_DB, Math.min(maxAt1k, expectedDb - 10));
    setStepIndex(0);
    resetPureAlgorithm(startDb);
    if (!testStartedAtRef.current) testStartedAtRef.current = new Date();
    setPhase('testing');
  }

  function handlePracticeResponse(heard) {
    if (!tonePlayed || isPlaying) return;
    setTonePlayed(false);
    if (heard) {
      setPracticePassed(true);
      return;
    }
    const maxPractice = maxPlayableDbHl(deviceProfile, currentEar, 1000);
    const next = Math.min(maxPractice, practiceDb + 10);
    setPracticeDb(next);
    if (next >= maxPractice) {
      setPracticePassed(true);
      Alert.alert(
        'Practice tone not detected',
        `The setup reached its calibrated 1 kHz output ceiling (${maxPractice} dB HL). The threshold search can continue, but a no-response result may be recorded if the tone remains inaudible.`,
      );
    }
  }

  function finishPureStep(result) {
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
      const nextSteps = getStepsForEar(earAtFinish, nextThresholds[earAtFinish]);
      const nextIndex = indexAtFinish + 1;
      if (nextIndex >= nextSteps.length) {
        if (earAtFinish === 'right') {
          beginPureEar('left');
        } else {
          setPhase('done');
        }
        return;
      }
      const nextFrequency = nextSteps[nextIndex]?.freq ?? 1000;
      const nextMax = maxPlayableDbHl(deviceProfile, earAtFinish, nextFrequency);
      setStepIndex(nextIndex);
      resetPureAlgorithm(Math.min(suggestedStartDb(result), nextMax));
    }, 500);
  }

  function handlePureResponse(heard) {
    if (
      !tonePlayed ||
      isPlaying ||
      thresholdBanner ||
      volumeBlocked ||
      responseLockedRef.current ||
      !currentStep
    ) return;

    responseLockedRef.current = true;
    setTonePlayed(false);
    const db = currentDbRef.current;
    const arrivedAscending = directionRef.current === 'asc';
    const hadDescent = hadDescentRef.current;
    const validAscending = (arrivedAscending && hadDescent) || (db === MIN_DB && hadDescent);

    setHistory((previous) => [
      ...previous,
      { db, heard, validAscending, stepId: currentStep.id },
    ]);

    const currentMaxDb = maxPlayableDbHl(deviceProfile, currentEar, currentFrequency);
    if (!heard && db >= currentMaxDb) {
      maxMissesRef.current += 1;
      if (maxMissesRef.current >= 2) {
        finishPureStep(noResponseResult(currentMaxDb));
        return;
      }
      directionRef.current = 'asc';
      setDirectionDisplay('asc');
      showFeedback(false, 0, `Calibrated output ceiling (${currentMaxDb} dB HL) missed once — repeat for confirmation`);
      responseLockedRef.current = false;
      return;
    }

    maxMissesRef.current = 0;
    if (validAscending) {
      const window = addAscendingTrial(db, heard);
      if (window.filter(Boolean).length >= 2) {
        let floorLimited = false;
        try {
          floorLimited =
            dbHLToAmplitude(db, currentFrequency, deviceProfile, currentEar).dBFS <=
            DBFS_FLOOR_WARNING_THRESHOLD;
        } catch (_) {}
        finishPureStep(thresholdResult(db, floorLimited));
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
      const nextDb = Math.min(currentMaxDb, db + STEP_UP);
      currentDbRef.current = nextDb;
      directionRef.current = 'asc';
      setCurrentDb(nextDb);
      setDirectionDisplay('asc');
      showFeedback(false, nextDb - db);
    }
    responseLockedRef.current = false;
  }

  async function proceedFromSetup() {
    Keyboard.dismiss();
    try {
      await AsyncStorage.setItem(HARDWARE_PREFS_KEY, JSON.stringify({
        phoneModel: resolvedPhoneModel,
        headphoneDescription: headphoneDescription.trim(),
        connectionType,
      }));
    } catch (_) {}
    const acoustic = lookupDeviceProfile(profileKey);
    if (acoustic) {
      setDeviceProfile(acoustic);
      setTestMode('acoustic_pure_tone');
      setChannelCheck({ right: false, left: false });
      setChannelCheckEar(null);
      setChannelResponseReady(false);
      setPhase('channel_check');
      return;
    }

    const biological = await loadBiologicalProfile(profileKey);
    if (biological) {
      setDeviceProfile(biological);
      setTestMode('biological_pure_tone');
      setChannelCheck({ right: false, left: false });
      setChannelCheckEar(null);
      setChannelResponseReady(false);
      setPhase('channel_check');
      return;
    }

    setDeviceProfile(null);
    setTestMode(null);
    setBioMergeBaseProfile(null);
    setBioReferenceConfirmed(false);
    setPhase('calibration_info');
  }

  async function saveClinicalValidationAndAnchor() {
    if (savingValidation) return;
    const comparison = computeClinicalComparison(thresholdsRef.current, validationClinicalThresholds);
    if (!comparison) {
      Alert.alert('Clinical thresholds required', 'Enter at least one conventional audiogram threshold that corresponds to a completed HearSmart threshold.');
      return;
    }

    setSavingValidation(true);
    try {
      const clinical = parsedClinicalThresholds(validationClinicalThresholds);
      const record = {
        createdAt: new Date().toISOString(),
        phoneModel: resolvedPhoneModel,
        headphoneModel: headphoneDescription.trim(),
        connectionType,
        appVersion: APP_VERSION,
        profileMethod: calibrationMethodLabel(deviceProfile),
        profileConfidence: profileConfidenceLabel(deviceProfile),
        clinical,
        hearSmart: {
          right: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, resultDb(acceptedResultForFrequency(thresholdsRef.current.right, frequency))])),
          left: Object.fromEntries(PURE_TONE_FREQUENCIES.map((frequency) => [frequency, resultDb(acceptedResultForFrequency(thresholdsRef.current.left, frequency))])),
        },
        metrics: {
          mae: comparison.mae,
          bias: comparison.bias,
          within5: comparison.within5,
          within10: comparison.within10,
          points: comparison.rows.length,
        },
      };
      await saveValidationRecord(profileKey, record);

      if (deviceProfile?.type !== 'biological') {
        setValidationMessage(`Saved ${comparison.rows.length} paired point${comparison.rows.length === 1 ? '' : 's'} for validation. Acoustic profiles are not automatically changed by patient comparison data.`);
        return;
      }

      const currentProfile = deviceProfile;
      const nextZero = {
        right: { ...currentProfile.thresholdDbfs.right },
        left: { ...currentProfile.thresholdDbfs.left },
      };
      const counts = ensureClinicalAnchorCounts(currentProfile);
      const clinicalMeans = {
        right: { ...(currentProfile.clinicalAnchorMeanDbfs?.right || {}) },
        left: { ...(currentProfile.clinicalAnchorMeanDbfs?.left || {}) },
      };

      for (const row of comparison.rows) {
        const currentZero = Number(currentProfile.thresholdDbfs[row.ear][row.frequency]);
        if (!Number.isFinite(currentZero)) continue;
        const impliedDigitalThreshold = currentZero + row.appDb;
        const impliedZeroDbfs = impliedDigitalThreshold - row.clinicalDb;
        const n = counts[row.ear][row.frequency];
        const oldClinicalMean = Number(clinicalMeans?.[row.ear]?.[row.frequency]);
        const updatedMean = n > 0 && Number.isFinite(oldClinicalMean)
          ? ((oldClinicalMean * n) + impliedZeroDbfs) / (n + 1)
          : impliedZeroDbfs;
        clinicalMeans[row.ear][row.frequency] = Math.round(updatedMean * 10) / 10;
        counts[row.ear][row.frequency] = n + 1;
        nextZero[row.ear][row.frequency] = clinicalMeans[row.ear][row.frequency];
      }

      const updatedProfile = {
        ...currentProfile,
        profileVersion: 2,
        thresholdDbfs: nextZero,
        clinicalAnchorMeanDbfs: clinicalMeans,
        clinicalAnchorCounts: counts,
        clinicalAnchorSessions: Number(currentProfile.clinicalAnchorSessions || currentProfile.clinicalReferenceCount || 0) + 1,
        updatedAt: new Date().toISOString(),
        lastValidationMetrics: record.metrics,
        method: `${currentProfile.method || 'Biological calibration'}; updated with paired conventional-audiogram anchors`,
      };

      const saved = await saveBiologicalProfile(profileKey, updatedProfile);
      if (!saved) {
        Alert.alert('Profile update warning', 'The clinical comparison was saved for this session, but the updated calibration profile could not be persisted.');
      }
      setDeviceProfile(updatedProfile);
      setValidationMessage(
        `Saved ${comparison.rows.length} paired clinical point${comparison.rows.length === 1 ? '' : 's'}. Future tests on this exact hardware profile will use the updated frequency-specific clinical anchors. This same participant must not be counted as an independent validation case after the profile is updated.`,
      );
    } catch (error) {
      Alert.alert('Could not save validation', error?.message ?? 'Unable to save the clinical comparison.');
    } finally {
      setSavingValidation(false);
    }
  }

  function resetAll() {
    clearTimers();
    cancelPresentation();
    thresholdsRef.current = { right: {}, left: {} };
    toneCacheRef.current.clear();
    testStartedAtRef.current = null;
    setParticipantName('');
    setParticipantAge('');
    setParticipantSex(null);
    setReferredBy('');
    setChiefComplaint('');
    setTestId('');
    // Keep the hardware identity between patients so a saved profile can be reused immediately.
    setPhoneModel((value) => value || Device.modelName || '');
    setHeadphonesConfirmed(false);
    setQuietRoomConfirmed(false);
    setOtoscopyStatus(null);
    setAcuteEarSymptoms(false);
    setTestMode(null);
    setDeviceProfile(null);
    bioCalibrationDataRef.current = { right: {}, left: {} };
    setBioCalibrationData({ right: {}, left: {} });
    setBioEar('right');
    setBioFreqIndex(0);
    setBioReferenceConfirmed(false);
    setBioMergeBaseProfile(null);
    setBioReferenceMode('clinical');
    setBioClinicalThresholds(emptyClinicalThresholdMap());
    setValidationClinicalThresholds(emptyClinicalThresholdMap());
    setValidationMessage(null);
    resetBioAlgorithm(BIO_CAL_START_DBFS);
    setChannelCheck({ right: false, left: false });
    setChannelCheckEar(null);
    setChannelResponseReady(false);
    setThresholds({ right: {}, left: {} });
    setCurrentEar(null);
    setStepIndex(0);
    setPracticeDb(30);
    setPracticePassed(false);
    setThresholdBanner(null);
    resetPureAlgorithm(DEFAULT_START_DB);
    setPhase('setup');
  }

  async function exportPureTonePdf() {
    if (exporting) return;
    setExporting(true);
    try {
      if (!isValidDeviceProfile(deviceProfile)) throw new Error('Calibration profile missing.');
      const rightPta = computeClinicalPTA(thresholds.right);
      const leftPta = computeClinicalPTA(thresholds.left);
      const rightPta4 = computeFourFrequencyPTA(thresholds.right);
      const leftPta4 = computeFourFrequencyPTA(thresholds.left);
      const rightClass = classify(rightPta);
      const leftClass = classify(leftPta);
      const rightSvg = buildEarAudiogramSvg('right', thresholds.right);
      const leftSvg = buildEarAudiogramSvg('left', thresholds.left);
      const interpretation = buildProvisionalDiagnosis(rightPta, leftPta);
      const unit = levelUnitLabel(deviceProfile);
      const calibrationMethod = calibrationMethodLabel(deviceProfile);
      const confidence = profileConfidenceLabel(deviceProfile);
      const rightReliable = is1000RetestReliable(thresholds.right);

      const reportResult = (result) => {
        if (!result) return '—';
        if (result.kind === 'no_response') return `NR at ${result.maxDb} ${unit}`;
        return `${result.db} ${unit}`;
      };

      const thresholdRows = PURE_TONE_FREQUENCIES.map((frequency) => {
        const r = acceptedResultForFrequency(thresholds.right, frequency);
        const l = acceptedResultForFrequency(thresholds.left, frequency);
        return `<tr><td>${formatFrequency(frequency)}</td><td>${escapeHtml(reportResult(r))}</td><td>${escapeHtml(reportResult(l))}</td></tr>`;
      }).join('');

      const calibrationRows = PURE_TONE_FREQUENCIES.map((frequency) => {
        if (deviceProfile.type === 'biological') {
          const r = deviceProfile.thresholdDbfs.right[frequency];
          const l = deviceProfile.thresholdDbfs.left[frequency];
          return `<tr><td>${formatFrequency(frequency)}</td><td>${r.toFixed(0)} dBFS</td><td>${l.toFixed(0)} dBFS</td><td>Biological 0-reference</td></tr>`;
        }
        const spl = deviceProfile.splAtZeroDbfs[frequency];
        const retspl = deviceProfile.retsplDb[frequency];
        return `<tr><td>${formatFrequency(frequency)}</td><td>${spl.toFixed(1)} dB SPL</td><td>${retspl.toFixed(1)} dB</td><td>Safe ceiling ${deviceProfile.maxSafeDbHl[frequency].toFixed(0)} dB HL</td></tr>`;
      }).join('');

      const digitalRows = PURE_TONE_FREQUENCIES.map((frequency) => {
        const r = acceptedResultForFrequency(thresholds.right, frequency);
        const l = acceptedResultForFrequency(thresholds.left, frequency);
        const rLabel = volumeLabelForResult(frequency, r, deviceProfile, 'right') || '—';
        const lLabel = volumeLabelForResult(frequency, l, deviceProfile, 'left') || '—';
        return `<tr><td>${formatFrequency(frequency)}</td><td>${escapeHtml(rLabel)}</td><td>${escapeHtml(lLabel)}</td></tr>`;
      }).join('');

      const recommendation = (rightClass && rightClass.shortLabel !== 'Normal') || (leftClass && leftClass.shortLabel !== 'Normal')
        ? 'Confirm these air-conduction findings with a licensed audiologist using a calibrated clinical audiometer, including bone conduction and masking when indicated.'
        : 'Air-conduction thresholds are within the app\'s normal-range criterion. Obtain professional assessment if symptoms, sudden change, unilateral concerns, tinnitus, dizziness, or communication difficulty are present.';

      const calibrationLimitation = deviceProfile.type === 'acoustic'
        ? 'This run used an externally measured acoustic hardware profile. Clinical equivalence still depends on calibration traceability, transducer/coupler method, test environment, placement, and validation of this complete software/hardware chain.'
        : Number(deviceProfile.clinicalAnchorSessions || 0) > 0
          ? 'This run used a biological hardware profile that has been anchored to one or more paired conventional audiograms. It remains a research calibration, not a traceable clinical audiometer calibration; independent held-out validation is required before clinical-equivalence claims.'
          : 'This run used a biological reference profile without a clinical anchor. Absolute thresholds may carry systematic bias because the reference listener was treated as 0 dB HL. Pair this hardware profile with conventional audiograms before relying on absolute dB-HL agreement.';

      const html = `<!doctype html><html><head><meta charset="utf-8"/><style>
        @page{size:A4 portrait;margin:13px}*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#172033;font-size:9.5px;margin:0}
        h1{font-size:22px;text-align:center;margin:0 0 2px}.sub{text-align:center;color:#0d6e8a;margin-bottom:7px}.form{border:1.5px solid #334155;padding:6px;margin-bottom:6px}.grid{display:grid;grid-template-columns:1.35fr 1fr;gap:3px 14px}.line{border-bottom:1px solid #94a3b8;padding:2px 0}.label{font-weight:900;font-size:8px}.section{border:1px solid #cbd5e1;padding:6px;margin-bottom:6px;break-inside:avoid}.title{font-weight:900;font-size:10.5px;margin-bottom:4px}.plots{display:flex;gap:7px;align-items:flex-start}.plot{flex:1;text-align:center}.symbol{width:142px;border-collapse:collapse;font-size:7.5px}.symbol th,.symbol td{border:1px solid #64748b;padding:2.5px;text-align:center}.right{color:${RIGHT_COLOR}}.left{color:${LEFT_COLOR}}table.data{width:100%;border-collapse:collapse}.data th,.data td{border:1px solid #cbd5e1;padding:3.5px;text-align:center}.data th{background:#f1f5f9}.diagnosis{border:1px solid #94a3b8;padding:6px;min-height:30px}.warn{border:1.4px solid #f59e0b;background:#fffbeb;padding:6px;line-height:1.4}.note{font-size:7.8px;color:#64748b;line-height:1.35}.signature{display:flex;justify-content:space-between;margin-top:7px;padding-top:6px;border-top:1px solid #94a3b8}.pagebreak{page-break-before:always}
      </style></head><body>
        <h1>Pure Tone Audiogram</h1><div class="sub">HearSmart air-conduction audiometry research report · v${APP_VERSION}</div>
        <div class="form"><div class="grid">
          <div class="line"><span class="label">NAME:</span> ${escapeHtml(participantName || 'Not provided')}</div><div class="line"><span class="label">DATE:</span> ${escapeHtml(new Date().toLocaleString('en-IN'))}</div>
          <div class="line"><span class="label">COMPLAINT:</span> ${escapeHtml(chiefComplaint || 'Not provided')}</div><div class="line"><span class="label">AGE / SEX:</span> ${escapeHtml(participantAge || 'Not provided')} / ${escapeHtml(participantSex || 'Not provided')}</div>
          <div class="line"><span class="label">REF. SOURCE:</span> ${escapeHtml(referredBy || 'Not provided')}</div><div class="line"><span class="label">TEST ID:</span> ${escapeHtml(testId || 'Not provided')}</div>
          <div class="line"><span class="label">PHONE:</span> ${escapeHtml(resolvedPhoneModel || 'Unknown')}</div><div class="line"><span class="label">HEADPHONES:</span> ${escapeHtml(headphoneDescription || 'Not provided')} · ${escapeHtml(connectionType)}</div>
          <div class="line"><span class="label">CALIBRATION:</span> ${escapeHtml(calibrationMethod)}</div><div class="line"><span class="label">CONFIDENCE:</span> ${escapeHtml(confidence)}</div>
          <div class="line"><span class="label">SYSTEM VOLUME:</span> ${Math.round(targetVolume * 100)}%</div><div class="line"><span class="label">PROFILE DATE:</span> ${escapeHtml(profileDateLabel(deviceProfile))}</div>
          <div class="line"><span class="label">REFERENCE COUNT:</span> ${deviceProfile.type === 'biological' ? escapeHtml(String(deviceProfile.referenceCount || 1)) : 'N/A — acoustic'}</div><div class="line"><span class="label">EAR ORDER:</span> Right ear completed first, then left ear</div>
          <div class="line"><span class="label">ENVIRONMENT:</span> Quiet-room confirmation completed</div><div class="line"><span class="label">AMBIENT LEVEL:</span> Not instrument-measured</div>
          <div class="line"><span class="label">OTOSCOPY / EAR CHECK:</span> ${escapeHtml(otoscopyStatus === 'clear' ? 'Reported clear before test' : otoscopyStatus === 'not_checked' ? 'Not available / not performed' : 'Concern reported')}</div><div class="line"><span class="label">ACUTE EAR SYMPTOMS:</span> ${acuteEarSymptoms ? 'Reported — test should be deferred' : 'Not reported'}</div>
        </div></div>

        <div class="section"><div class="title">AIR-CONDUCTION PURE-TONE AUDIOGRAM</div><div class="plots"><div class="plot">${rightSvg}</div><div class="plot">${leftSvg}</div><table class="symbol"><tr><th colspan="3">SYMBOLS</th></tr><tr><th>Measure</th><th>Right</th><th>Left</th></tr><tr><td>Air unmasked</td><td>O</td><td>X</td></tr><tr><td>Air masked</td><td>△</td><td>□</td></tr><tr><td>Bone unmasked</td><td>&lt;</td><td>&gt;</td></tr><tr><td>Bone masked</td><td>[</td><td>]</td></tr><tr><td>No response</td><td>O↓</td><td>X↓</td></tr></table></div><div class="note">HearSmart currently populates unmasked air-conduction thresholds only. Masked air and bone symbols are shown solely for audiogram-form compatibility and remain unpopulated.</div></div>

        <div class="section"><div class="title">PTA / SRT / SDS / SISI / TDT</div><table class="data"><tr><th></th><th>PTA*</th><th>SRT</th><th>SDS</th><th>SISI</th><th>TDT</th></tr><tr><td class="right"><b>Right</b></td><td>${rightPta == null ? 'Unavailable' : `${rightPta} ${unit}`}</td><td>Not assessed</td><td>Not assessed</td><td>Not assessed</td><td>Not assessed</td></tr><tr><td class="left"><b>Left</b></td><td>${leftPta == null ? 'Unavailable' : `${leftPta} ${unit}`}</td><td>Not assessed</td><td>Not assessed</td><td>Not assessed</td><td>Not assessed</td></tr></table><div class="note">* Primary PTA = mean of 500 Hz, 1 kHz and 2 kHz. Four-frequency PTA (500 Hz, 1 kHz, 2 kHz, 4 kHz): Right ${rightPta4 == null ? 'Unavailable' : `${rightPta4} ${unit}`}; Left ${leftPta4 == null ? 'Unavailable' : `${leftPta4} ${unit}`}.</div></div>

        <div class="section"><div class="title">THRESHOLD SUMMARY</div><table class="data"><tr><th>Frequency</th><th>Right</th><th>Left</th></tr>${thresholdRows}</table><div class="note">Right-ear 1 kHz repeatability: ${rightReliable == null ? 'not available' : rightReliable ? 'within 5 dB' : 'difference >5 dB; lower 1 kHz value retained and 2 kHz rechecked'}.</div></div>
        <div class="section"><div class="title">RESPONSE RELIABILITY</div><table class="data"><tr><th>Indicator</th><th>Finding</th></tr><tr><td>1 kHz test-retest</td><td>${rightReliable == null ? 'Not available' : rightReliable ? 'Consistent within 5 dB' : 'Caution — difference greater than 5 dB'}</td></tr><tr><td>Response method</td><td>Self-administered heard / not-heard response after each completed presentation</td></tr><tr><td>Replay</td><td>Permitted without advancing the staircase</td></tr></table></div>
        <div class="section"><div class="title">TFT / BONE / MASKING</div><table class="data"><tr><th></th><th>Right</th><th>Left</th></tr><tr><td>Rinne</td><td>Not assessed</td><td>Not assessed</td></tr><tr><td>Weber</td><td>Not assessed</td><td>Not assessed</td></tr><tr><td>Bone conduction</td><td>Not assessed</td><td>Not assessed</td></tr><tr><td>Masking</td><td>Not assessed</td><td>Not assessed</td></tr></table></div>
        <div class="section"><div class="title">PROVISIONAL INTERPRETATION — AIR CONDUCTION ONLY</div><div class="diagnosis">${escapeHtml(interpretation)}</div></div>
        <div class="section"><div class="title">RECOMMENDATION</div>${escapeHtml(recommendation)}</div>
        <div class="warn"><b>Calibration / research limitation:</b> ${escapeHtml(calibrationLimitation)} This application does not perform bone conduction, clinical masking, speech audiometry, tympanometry, or diagnostic differentiation of conductive versus sensorineural hearing loss. Clinical decisions require professional assessment.</div>
        <div class="signature"><span>HearSmart v${APP_VERSION}</span><span>Audiologist / reviewer: ____________________</span></div>

        <div class="pagebreak"></div>
        <h1 style="font-size:18px">Technical Test Record</h1><div class="sub">Reproducibility and calibration details</div>
        <div class="section"><div class="title">CALIBRATION REFERENCE</div><table class="data"><tr><th>Frequency</th><th>${deviceProfile.type === 'biological' ? 'Right reference' : 'SPL @ 0 dBFS'}</th><th>${deviceProfile.type === 'biological' ? 'Left reference' : 'RETSPL'}</th><th>Method</th></tr>${calibrationRows}</table></div>
        <div class="section"><div class="title">DIGITAL LEVEL AT ACCEPTED THRESHOLD</div><table class="data"><tr><th>Frequency</th><th>Right</th><th>Left</th></tr>${digitalRows}</table></div>
        <div class="section"><div class="title">TEST METHOD</div><div class="note">The complete right ear is tested before the left ear. Within the right ear, the air-conduction sequence is 1 kHz, 2 kHz, 3 kHz, 4 kHz, 6 kHz, 8 kHz, 1 kHz retest, then 500 Hz and 250 Hz. The left ear follows the same frequency order but omits the routine 1 kHz retest. Threshold search uses 10 dB down after a response and 5 dB up after a non-response; threshold is accepted after at least two responses in three ascending presentations at the same level. Replay repeats the same ear/frequency/level and does not change the staircase until a response is submitted.</div></div>
      </body></html>`;
      await sharePdf(html, 'HearSmart pure-tone audiogram');
    } catch (error) {
      Alert.alert('Report export failed', error?.message ?? 'Unable to generate the PDF.');
    } finally {
      setExporting(false);
    }
  }

  const overlay = (
    <VolumeBlockedOverlay
      volumeBlocked={volumeBlocked}
      systemVolume={systemVolume}
      targetVolume={targetVolume}
      onSetTargetVolume={setTargetVolume}
    />
  );

  const volumeGate = (
    <VolumeGate
      systemVolume={systemVolume}
      volumeLoading={volumeLoading}
      volumeReady={volumeReady}
      targetVolume={targetVolume}
      onSetTargetVolume={setTargetVolume}
    />
  );

  if (phase === 'setup') {
    const canContinue =
      volumeReady &&
      headphonesConfirmed &&
      quietRoomConfirmed &&
      otoscopyStatus != null &&
      otoscopyStatus !== 'concern' &&
      !acuteEarSymptoms &&
      resolvedPhoneModel.length > 0 &&
      headphoneDescription.trim().length > 0;

    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.appName}>HearSmart</Text>
          <Text style={styles.appSub}>Professional audiometry research system · v{APP_VERSION}</Text>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Test information</Text>
            <TextInput value={participantName} onChangeText={setParticipantName} placeholder="Participant name (optional)" placeholderTextColor="#64748B" style={styles.input} />
            <TextInput value={participantAge} onChangeText={setParticipantAge} placeholder="Age (optional)" placeholderTextColor="#64748B" keyboardType="number-pad" style={styles.input} />
            <View style={styles.sexRow}>
              {['female', 'male', 'other'].map((option) => (
                <TouchableOpacity key={option} style={[styles.sexPill, participantSex === option && styles.sexPillActive]} onPress={() => setParticipantSex(option)}>
                  <Text style={[styles.sexPillText, participantSex === option && styles.sexPillTextActive]}>{option.charAt(0).toUpperCase() + option.slice(1)}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TextInput value={referredBy} onChangeText={setReferredBy} placeholder="Referred by / clinician (optional)" placeholderTextColor="#64748B" style={styles.input} />
            <TextInput value={chiefComplaint} onChangeText={setChiefComplaint} placeholder="Chief complaint (optional)" placeholderTextColor="#64748B" style={styles.input} />
            <TextInput value={testId} onChangeText={setTestId} placeholder="Test ID (optional)" placeholderTextColor="#64748B" style={styles.input} />
            <TextInput value={resolvedPhoneModel} onChangeText={setPhoneModel} editable={!Device.modelName} placeholder="Phone model" placeholderTextColor="#64748B" style={styles.input} />
            <TextInput value={headphoneDescription} onChangeText={setHeadphoneDescription} placeholder="Headphone / earphone model" placeholderTextColor="#64748B" style={styles.input} />
            <View style={styles.sexRow}>
              {['wired', 'bluetooth'].map((option) => (
                <TouchableOpacity key={option} style={[styles.sexPill, connectionType === option && styles.sexPillActive]} onPress={() => setConnectionType(option)}>
                  <Text style={[styles.sexPillText, connectionType === option && styles.sexPillTextActive]}>{option === 'wired' ? 'Wired' : 'Bluetooth'}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {volumeGate}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Pre-test ear check</Text>
            <Text style={styles.cardBody}>Pure-tone threshold testing should follow ear-canal inspection when possible. Choose the status that is actually true for this session.</Text>
            <View style={[styles.sexRow, { flexWrap: 'wrap' }]}>
              {[
                ['clear', 'Otoscopy clear'],
                ['not_checked', 'Not checked'],
                ['concern', 'Wax / obstruction / concern'],
              ].map(([value, label]) => (
                <TouchableOpacity key={value} style={[styles.sexPill, otoscopyStatus === value && styles.sexPillActive]} onPress={() => setOtoscopyStatus(value)}>
                  <Text style={[styles.sexPillText, otoscopyStatus === value && styles.sexPillTextActive]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.confirmRow} onPress={() => setAcuteEarSymptoms((value) => !value)}>
              <View style={[styles.checkbox, acuteEarSymptoms && { backgroundColor: '#B91C1C', borderColor: '#B91C1C' }]}><Text style={styles.checkboxText}>{acuteEarSymptoms ? '!' : ''}</Text></View>
              <Text style={styles.confirmText}>There is current ear pain, discharge, sudden major hearing change, or another acute ear concern.</Text>
            </TouchableOpacity>
            {otoscopyStatus === 'concern' || acuteEarSymptoms ? (
              <Text style={[styles.smallNote, { color: '#FCA5A5', fontWeight: '700' }]}>Do not continue this research test until the ear concern has been appropriately assessed. Excessive cerumen or obstruction can change air-conduction thresholds.</Text>
            ) : otoscopyStatus === 'not_checked' ? (
              <Text style={[styles.smallNote, { color: '#FDE68A' }]}>Research mode: otoscopy was not available. The report will record this limitation.</Text>
            ) : null}
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>{matchedProfile ? 'Laboratory acoustic profile found' : 'Professional pure-tone pathway'}</Text>
            <Text style={styles.cardBody}>
              {matchedProfile
                ? 'This exact phone + headphone + connection combination has an acoustic calibration profile. HearSmart will use it directly for the pure-tone test.'
                : 'HearSmart will look for a saved calibration profile for this exact setup. If none exists, create one once and reuse it for future patients. A reference listener with a recent conventional audiogram is preferred because the known clinical thresholds can anchor each frequency instead of assuming the reference listener is 0 dB HL.'}
            </Text>
          </View>

          {isLikelyWirelessHeadphone(headphoneDescription) ? (
            <View style={[styles.card, { borderColor: '#B45309', borderWidth: 1.5 }]}>
              <Text style={[styles.cardTitle, { color: '#FDE68A' }]}>{connectionType === 'wired' ? 'Check connection type' : 'Wireless-processing warning'}</Text>
              <Text style={styles.cardBody}>
                {connectionType === 'wired'
                  ? 'The headphone name looks like a wireless model, but “Wired” is selected. If the headphones are connected by Bluetooth, change the selection before testing so the report and hardware-profile lookup are correct.'
                  : 'Bluetooth headphones can apply EQ, compression, spatial processing, or adaptive level control. Keep enhancement and noise-control features off when possible. A separate biological calibration is stored for this exact Bluetooth setup.'}
              </Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Before you begin</Text>
            {[
              'Use headphones or earphones and keep their position unchanged.',
              'Use the quietest room available; avoid fans, traffic, TV, and conversation.',
              `Keep system media volume at ${Math.round(targetVolume * 100)}% for the entire run.`,
              'Stop immediately if any presentation is uncomfortable.',
              'Right and left channels are checked before testing.',
              matchedProfile ? 'Acoustic calibration is available for this exact setup.' : 'If this setup is new, create a hardware profile once. Prefer a reference listener with a recent clinical audiogram.',
            ].map((item, index) => (
              <View style={styles.checkRow} key={item}>
                <View style={styles.checkCircle}><Text style={styles.checkNumber}>{index + 1}</Text></View>
                <Text style={styles.checkText}>{item}</Text>
              </View>
            ))}
            <TouchableOpacity style={styles.confirmRow} onPress={() => setHeadphonesConfirmed((value) => !value)}>
              <View style={[styles.checkbox, headphonesConfirmed && styles.checkboxChecked]}><Text style={styles.checkboxText}>{headphonesConfirmed ? '✓' : ''}</Text></View>
              <Text style={styles.confirmText}>I am wearing the headphones securely.</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.confirmRow} onPress={() => setQuietRoomConfirmed((value) => !value)}>
              <View style={[styles.checkbox, quietRoomConfirmed && styles.checkboxChecked]}><Text style={styles.checkboxText}>{quietRoomConfirmed ? '✓' : ''}</Text></View>
              <Text style={styles.confirmText}>I am in a quiet room.</Text>
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={[styles.primaryButton, !canContinue && styles.disabledButton]} disabled={!canContinue} onPress={proceedFromSetup}>
            <Text style={styles.primaryButtonText}>Continue</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  if (phase === 'calibration_info') {
    const calibrationChannelsReady = channelCheck.right && channelCheck.left;
    const clinicalReferenceReady = bioReferenceMode !== 'clinical' || hasCompleteClinicalAudiogram(bioClinicalThresholds);
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Reference calibration</Text>
          <Text style={styles.appSub}>{bioMergeBaseProfile ? 'Add another reference to improve this saved hardware profile' : 'One-time calibration for this exact phone + headphone setup'}</Text>
          {volumeGate}

          <View style={[styles.card, { borderWidth: 1.5, borderColor: '#F59E0B' }]}>
            <Text style={[styles.cardTitle, { color: '#FDE68A' }]}>Create or improve this hardware profile</Text>
            <Text style={styles.cardBody}>
              {bioMergeBaseProfile ? `This setup already has ${bioMergeBaseProfile.referenceCount || 1} reference session${(bioMergeBaseProfile.referenceCount || 1) === 1 ? '' : 's'}. ` : ''}The preferred method is to use a reference listener who already has a recent conventional pure-tone audiogram. HearSmart measures that person's digital threshold, subtracts the known clinical dB HL threshold frequency-by-frequency, and stores the resulting hardware 0-dB-HL reference. This directly avoids the old assumption that every reference listener hears at exactly 0 dB HL.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Reference type</Text>
            <View style={[styles.sexRow, { flexWrap: 'wrap' }]}>
              <TouchableOpacity style={[styles.sexPill, bioReferenceMode === 'clinical' && styles.sexPillActive]} onPress={() => setBioReferenceMode('clinical')}>
                <Text style={[styles.sexPillText, bioReferenceMode === 'clinical' && styles.sexPillTextActive]}>Known clinical audiogram · preferred</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.sexPill, bioReferenceMode === 'assumed_normal' && styles.sexPillActive]} onPress={() => setBioReferenceMode('assumed_normal')}>
                <Text style={[styles.sexPillText, bioReferenceMode === 'assumed_normal' && styles.sexPillTextActive]}>No clinical audiogram · experimental</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.smallNote}>{bioReferenceMode === 'clinical' ? 'Enter the conventional air-conduction thresholds below. These are used only to calibrate the hardware profile; they are not copied into future patient results.' : 'Without a known clinical audiogram, the reference listener is treated as 0 dB HL at each frequency. This can create a systematic 10–20 dB bias if their actual thresholds are above 0 dB HL, so use this only for early research.'}</Text>
          </View>

          {bioReferenceMode === 'clinical' ? (
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Reference listener conventional audiogram</Text>
              <Text style={styles.cardBody}>Enter the most recent clinical air-conduction thresholds in dB HL. Use the same ear/frequency values shown on the audiologist's audiogram.</Text>
              {['right', 'left'].map((ear) => (
                <View key={`clinical-ref-${ear}`} style={{ marginTop: 12 }}>
                  <Text style={[styles.cardTitle, { color: ear === 'right' ? RIGHT_COLOR : LEFT_COLOR }]}>{ear === 'right' ? 'Right ear (O)' : 'Left ear (X)'}</Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {PURE_TONE_FREQUENCIES.map((frequency) => (
                      <View key={`${ear}-${frequency}`} style={{ width: '30%', minWidth: 92 }}>
                        <Text style={styles.smallNote}>{formatFrequency(frequency)}</Text>
                        <TextInput
                          value={String(bioClinicalThresholds?.[ear]?.[frequency] ?? '')}
                          onChangeText={(value) => setBioClinicalThresholds((previous) => ({ ...previous, [ear]: { ...previous[ear], [frequency]: value } }))}
                          keyboardType="numbers-and-punctuation"
                          placeholder="dB HL"
                          placeholderTextColor="#64748B"
                          style={styles.input}
                        />
                      </View>
                    ))}
                  </View>
                </View>
              ))}
              <Text style={[styles.smallNote, { color: clinicalReferenceReady ? '#86EFAC' : '#FDE68A' }]}>{clinicalReferenceReady ? '✓ Complete 16-point clinical reference entered.' : `${clinicalAudiogramEntryCount(bioClinicalThresholds)}/16 clinical thresholds entered.`}</Text>
            </View>
          ) : null}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Why this is required</Text>
            <Text style={styles.cardBody}>
              Different phones and headphones produce different acoustic levels at the same digital setting. HearSmart therefore stores a separate frequency-by-frequency reference for this exact phone, headphone and connection type instead of assuming one universal output value.
            </Text>
          </View>

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Verify channels before calibration</Text>
            {['right', 'left'].map((ear) => {
              const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
              const ready = channelResponseReady && channelCheckEar === ear;
              return (
                <View key={`cal-${ear}`} style={{ marginBottom: 14 }}>
                  <Text style={[styles.cardBody, { marginBottom: 8 }]}>The check tone should be heard only in the {ear} ear.</Text>
                  <TouchableOpacity style={[styles.channelButton, { borderColor: color }]} onPress={() => playChannelCheck(ear)} disabled={isPlaying}>
                    <Text style={[styles.channelButtonText, { color }]}>{ready ? `Replay ${ear} check` : `Play ${ear} check`}</Text>
                  </TouchableOpacity>
                  {ready ? (
                    <View style={styles.responseRow}>
                      <TouchableOpacity style={styles.heardButton} onPress={() => { setChannelCheck((value) => ({ ...value, [ear]: true })); setChannelResponseReady(false); }}><Text style={styles.heardButtonText}>✓ Correct ear</Text></TouchableOpacity>
                      <TouchableOpacity style={styles.notHeardButton} onPress={() => { setChannelCheck((value) => ({ ...value, [ear]: false })); setChannelResponseReady(false); }}><Text style={styles.notHeardButtonText}>Wrong / not heard</Text></TouchableOpacity>
                    </View>
                  ) : null}
                  <Text style={{ color: channelCheck[ear] ? '#059669' : '#64748B', marginTop: 7 }}>{channelCheck[ear] ? '✓ Confirmed' : 'Not confirmed'}</Text>
                </View>
              );
            })}
          </View>

          <TouchableOpacity style={styles.confirmRow} onPress={() => setBioReferenceConfirmed((value) => !value)}>
            <View style={[styles.checkbox, bioReferenceConfirmed && styles.checkboxChecked]}><Text style={styles.checkboxText}>{bioReferenceConfirmed ? '✓' : ''}</Text></View>
            <Text style={styles.confirmText}>{bioReferenceMode === 'clinical' ? 'The clinical audiogram entered above belongs to the same reference listener who will complete this calibration.' : 'The person doing calibration is being used only as an experimental normal-hearing reference; I understand that assuming 0 dB HL can bias absolute results.'}</Text>
          </TouchableOpacity>

          <TouchableOpacity style={[styles.primaryButton, (!bioReferenceConfirmed || !calibrationChannelsReady || !clinicalReferenceReady) && styles.disabledButton]} disabled={!bioReferenceConfirmed || !calibrationChannelsReady || !clinicalReferenceReady} onPress={startBiologicalCalibration}>
            <Text style={styles.primaryButtonText}>Start reference calibration</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.resetLink} onPress={() => setPhase('setup')}><Text style={styles.resetLinkText}>Back to setup</Text></TouchableOpacity>
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'biological_calibration') {
    const frequency = BIO_CAL_ORDER[bioFreqIndex];
    const isRight = bioEar === 'right';
    const color = isRight ? RIGHT_COLOR : LEFT_COLOR;
    const completed = bioFreqIndex + (bioEar === 'left' ? BIO_CAL_ORDER.length : 0);
    const progress = Math.round((completed / (BIO_CAL_ORDER.length * 2)) * 100);
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Reference calibration</Text>
          <EarBadge ear={bioEar} />
          <Text style={styles.stepCountText}>{formatFrequency(frequency)} · {completed + 1} of {BIO_CAL_ORDER.length * 2}</Text>
          <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: color }]} /></View>
          {volumeGate}

          <View style={styles.dbCard}>
            <Text style={[styles.levelLabel, { color }]}>{formatFrequency(frequency)}</Text>
            <Text style={styles.dbUnit}>hardware reference threshold search</Text>
            <Text style={styles.smallNote}>Listen for the pure tone. This stage calibrates the hardware; it is not the patient's audiogram. The exact digital level is hidden during listening to reduce expectation bias.</Text>
          </View>

          <TouchableOpacity style={[styles.playButton, isPlaying && styles.stopButton]} onPress={isPlaying ? cancelPresentation : playBiologicalCalibrationTone}>
            <Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : bioResponseReady ? 'Replay same tone' : 'Present tone'}</Text>
          </TouchableOpacity>

          {bioResponseReady ? (
            <View style={styles.responseRow}>
              <TouchableOpacity style={styles.heardButton} onPress={() => handleBioResponse(true)}><Text style={styles.heardButtonText}>✓ I heard it</Text></TouchableOpacity>
              <TouchableOpacity style={styles.notHeardButton} onPress={() => handleBioResponse(false)}><Text style={styles.notHeardButtonText}>Nothing</Text></TouchableOpacity>
            </View>
          ) : null}

          <Text style={styles.smallNote}>You may replay the same tone if distracted. Replay does not change the calibration staircase until a response is submitted.</Text>
          {bioHistory.length > 0 ? <Text style={[styles.smallNote, { marginTop: 10 }]}>Presentations at this frequency: {bioHistory.length}</Text> : null}
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'channel_check') {
    const bothConfirmed = channelCheck.right && channelCheck.left;
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Channel check</Text>
          <Text style={styles.appSub}>Confirm left/right routing before the test</Text>
          {volumeGate}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Professional pure-tone pathway</Text>
            <Text style={styles.cardBody}>Calibration: {calibrationMethodLabel(deviceProfile)}. Confidence: {profileConfidenceLabel(deviceProfile)}. The channel-check tone verifies stereo routing only and is not a threshold measurement.</Text>
          </View>

          {['right', 'left'].map((ear) => {
            const color = ear === 'right' ? RIGHT_COLOR : LEFT_COLOR;
            const ready = channelResponseReady && channelCheckEar === ear;
            return (
              <View style={styles.card} key={ear}>
                <Text style={styles.cardTitle}>{ear === 'right' ? 'Right channel' : 'Left channel'}</Text>
                <Text style={styles.cardBody}>The sound should be heard only in the {ear} ear.</Text>
                <TouchableOpacity style={[styles.channelButton, { borderColor: color }]} onPress={() => playChannelCheck(ear)} disabled={isPlaying}>
                  <Text style={[styles.channelButtonText, { color }]}>{ready ? `Replay ${ear}-channel check` : `Play ${ear}-channel check`}</Text>
                </TouchableOpacity>
                {ready ? (
                  <View style={styles.responseRow}>
                    <TouchableOpacity style={styles.heardButton} onPress={() => {
                      setChannelCheck((value) => ({ ...value, [ear]: true }));
                      setChannelResponseReady(false);
                    }}><Text style={styles.heardButtonText}>✓ Correct ear</Text></TouchableOpacity>
                    <TouchableOpacity style={styles.notHeardButton} onPress={() => {
                      setChannelCheck((value) => ({ ...value, [ear]: false }));
                      setChannelResponseReady(false);
                      Alert.alert('Channel check failed', 'Verify headphone orientation, connection, and device audio routing before continuing.');
                    }}><Text style={styles.notHeardButtonText}>Wrong / not heard</Text></TouchableOpacity>
                  </View>
                ) : null}
                <Text style={{ color: channelCheck[ear] ? '#059669' : '#64748B', marginTop: 8 }}>{channelCheck[ear] ? '✓ Confirmed' : 'Not confirmed'}</Text>
              </View>
            );
          })}

          <TouchableOpacity
            style={[styles.primaryButton, !bothConfirmed && styles.disabledButton]}
            disabled={!bothConfirmed}
            onPress={() => beginPureEar('right')}
          >
            <Text style={styles.primaryButtonText}>Begin right-ear pure-tone test</Text>
          </TouchableOpacity>
          {deviceProfile?.type === 'biological' ? (
            <>
              <TouchableOpacity style={styles.secondaryButton} onPress={() => {
                setBioMergeBaseProfile(deviceProfile);
                setBioReferenceConfirmed(false);
                setChannelCheck({ right: false, left: false });
                setChannelCheckEar(null);
                setChannelResponseReady(false);
                setPhase('calibration_info');
              }}><Text style={styles.secondaryButtonText}>Add another normal-hearing reference</Text></TouchableOpacity>
              <TouchableOpacity style={styles.resetLink} onPress={() => {
                Alert.alert(
                  'Reset saved calibration?',
                  'This removes the biological reference profile for this exact setup.',
                  [
                    { text: 'Cancel', style: 'cancel' },
                    { text: 'Reset', style: 'destructive', onPress: async () => { await deleteBiologicalProfile(profileKey); setDeviceProfile(null); setBioMergeBaseProfile(null); setBioReferenceConfirmed(false); setChannelCheck({ right: false, left: false }); setPhase('calibration_info'); } },
                  ],
                );
              }}><Text style={styles.resetLinkText}>Reset saved calibration</Text></TouchableOpacity>
            </>
          ) : null}
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'ear_intro') {
    const isRight = currentEar === 'right';
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>{isRight ? 'Right ear' : 'Left ear'}</Text>
          <Text style={[styles.appSub, { color: earColor }]}>Profile-calibrated air-conduction pure-tone pathway</Text>
          <View style={[styles.card, { borderWidth: 2, borderColor: `${earColor}55` }]}>
            <Text style={[styles.earSymbol, { color: earColor }]}>{isRight ? 'O' : 'X'}</Text>
            <Text style={styles.cardTitle}>Testing {isRight ? 'right' : 'left'} ear</Text>
            <Text style={styles.cardBody}>Keep both sides of the headphones in place. Respond whenever you detect the tone, even if it is very faint.</Text>
          </View>
          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: earColor }]}
            onPress={() => {
              if (isRight) {
                setPracticePassed(false);
                setPhase('familiarize');
              } else {
                setPracticePassed(true);
                beginTestingCurrentEar();
              }
            }}
          ><Text style={styles.primaryButtonText}>{isRight ? 'Practice once, then begin' : 'Begin left-ear threshold test'}</Text></TouchableOpacity>
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'familiarize') {
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Practice</Text>
          <EarBadge ear={currentEar} />
          {volumeGate}
          <View style={styles.dbCard}>
            <Text style={styles.levelLabel}>1000 Hz practice</Text>
            <Text style={styles.dbNumber}>{practiceDb}</Text>
            <Text style={styles.dbUnit}>{levelUnitLabel(deviceProfile)} · {calibrationMethodLabel(deviceProfile)}</Text>
          </View>
          <TouchableOpacity style={[styles.playButton, isPlaying && styles.stopButton]} onPress={isPlaying ? cancelPresentation : () => playPureTone(1000, practiceDb, currentEar)}><Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : tonePlayed ? 'Replay practice tone' : 'Play practice tone'}</Text></TouchableOpacity>
          {tonePlayed ? (
            <View style={styles.responseRow}>
              <TouchableOpacity style={styles.heardButton} onPress={() => handlePracticeResponse(true)}><Text style={styles.heardButtonText}>✓ I heard it</Text></TouchableOpacity>
              <TouchableOpacity style={styles.notHeardButton} onPress={() => handlePracticeResponse(false)}><Text style={styles.notHeardButtonText}>Nothing</Text></TouchableOpacity>
            </View>
          ) : null}
          {practicePassed ? <TouchableOpacity style={[styles.primaryButton, { backgroundColor: earColor }]} onPress={beginTestingCurrentEar}><Text style={styles.primaryButtonText}>Begin threshold search</Text></TouchableOpacity> : <Text style={styles.smallNote}>Practice does not count toward the result.</Text>}
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'validation') {
    const comparison = computeClinicalComparison(thresholds, validationClinicalThresholds);
    const clinicalParsed = parsedClinicalThresholds(validationClinicalThresholds);
    const clinicalRightPta = clinicalPtaFromMap(clinicalParsed.right);
    const clinicalLeftPta = clinicalPtaFromMap(clinicalParsed.left);
    const appRightPta = computeClinicalPTA(thresholds.right);
    const appLeftPta = computeClinicalPTA(thresholds.left);
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.appName}>Clinical comparison</Text>
          <Text style={styles.appSub}>Paired conventional audiogram → validation + future hardware calibration</Text>

          <View style={[styles.card, { borderWidth: 1.5, borderColor: '#38BDF8' }]}>
            <Text style={styles.cardTitle}>Why enter this?</Text>
            <Text style={styles.cardBody}>Use the conventional audiologist thresholds from the same participant, ideally measured the same day or close in time. HearSmart calculates frequency-specific error and can use those paired points as calibration anchors for FUTURE tests on this exact phone + headphone + connection profile. It never rewrites the result you just measured.</Text>
          </View>

          {['right', 'left'].map((ear) => (
            <View style={styles.card} key={`validation-${ear}`}>
              <Text style={[styles.cardTitle, { color: ear === 'right' ? RIGHT_COLOR : LEFT_COLOR }]}>{ear === 'right' ? 'Right ear (O)' : 'Left ear (X)'}</Text>
              {PURE_TONE_FREQUENCIES.map((frequency) => {
                const appResult = acceptedResultForFrequency(thresholds[ear], frequency);
                const appDb = resultDb(appResult);
                return (
                  <View key={`${ear}-${frequency}`} style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                    <Text style={[styles.resultFrequency, { flex: 1 }]}>{formatFrequency(frequency)} · HearSmart {Number.isFinite(appDb) ? `${appDb} dB` : 'NR / unavailable'}</Text>
                    <TextInput
                      value={String(validationClinicalThresholds?.[ear]?.[frequency] ?? '')}
                      onChangeText={(value) => setValidationClinicalThresholds((previous) => ({ ...previous, [ear]: { ...previous[ear], [frequency]: value } }))}
                      keyboardType="numbers-and-punctuation"
                      placeholder="Clinical dB HL"
                      placeholderTextColor="#64748B"
                      style={[styles.input, { width: 130, marginBottom: 0 }]}
                    />
                  </View>
                );
              })}
            </View>
          ))}

          <View style={styles.card}>
            <Text style={styles.cardTitle}>Comparison summary</Text>
            <Text style={styles.cardBody}>PTA 500/1k/2k — HearSmart: Right {appRightPta == null ? '—' : `${appRightPta} dB`}, Left {appLeftPta == null ? '—' : `${appLeftPta} dB`}</Text>
            <Text style={styles.cardBody}>Clinical: Right {clinicalRightPta == null ? '—' : `${clinicalRightPta} dB HL`}, Left {clinicalLeftPta == null ? '—' : `${clinicalLeftPta} dB HL`}</Text>
            {comparison ? (
              <>
                <Text style={[styles.cardBody, { marginTop: 8, fontWeight: '800' }]}>Paired points: {comparison.rows.length} · MAE {comparison.mae} dB · Bias {comparison.bias > 0 ? '+' : ''}{comparison.bias} dB</Text>
                <Text style={styles.cardBody}>Within ±5 dB: {comparison.within5}% · Within ±10 dB: {comparison.within10}%</Text>
              </>
            ) : <Text style={styles.smallNote}>Enter clinical thresholds to calculate error statistics.</Text>}
          </View>

          {validationMessage ? <View style={[styles.card, { borderColor: '#10B981', borderWidth: 1.5 }]}><Text style={[styles.cardBody, { color: '#A7F3D0' }]}>{validationMessage}</Text></View> : null}

          <TouchableOpacity style={[styles.primaryButton, (!comparison || savingValidation) && styles.disabledButton]} disabled={!comparison || savingValidation} onPress={saveClinicalValidationAndAnchor}>
            {savingValidation ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.primaryButtonText}>Save paired clinical data + improve future profile</Text>}
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondaryButton} onPress={() => setPhase('done')}><Text style={styles.secondaryButtonText}>Back to HearSmart result</Text></TouchableOpacity>
          <Text style={styles.smallNote}>Important: after these clinical values are used to update the profile, this participant becomes calibration/development data, not an independent validation case for the updated profile.</Text>
        </ScrollView>
        {overlay}
      </SafeAreaView>
    );
  }

  if (phase === 'done') {
    const rightPta = computeClinicalPTA(thresholds.right);
    const leftPta = computeClinicalPTA(thresholds.left);
    const rightClassification = classify(rightPta);
    const leftClassification = classify(leftPta);
    return (
      <SafeAreaView style={styles.safe}>
        <ScrollView contentContainerStyle={styles.scroll}>
          <Text style={styles.appName}>Pure-tone test complete</Text>
          <Text style={styles.appSub}>{calibrationMethodLabel(deviceProfile)} · air conduction only</Text>
          <View style={styles.audiogramCard}>
            <Text style={[styles.cardTitle, { color: '#0A1628' }]}>Audiogram</Text>
            <Text style={styles.audiogramLegend}><Text style={{ color: RIGHT_COLOR, fontWeight: '700' }}>O right</Text>{'   ·   '}<Text style={{ color: LEFT_COLOR, fontWeight: '700' }}>X left</Text>{'   ·   ↓ no response'}</Text>
            <EarAudiogram ear="right" results={thresholds.right} />
            <View style={styles.audiogramDivider} />
            <EarAudiogram ear="left" results={thresholds.left} />
          </View>
          <View style={styles.diagnosisCard}><Text style={styles.diagnosisTitle}>Provisional interpretation</Text><Text style={styles.diagnosisText}>{buildProvisionalDiagnosis(rightPta, leftPta)}</Text></View>
          <EarResults ear="right" results={thresholds.right} pta={rightPta} classification={rightClassification} deviceProfile={deviceProfile} />
          <EarResults ear="left" results={thresholds.left} pta={leftPta} classification={leftClassification} deviceProfile={deviceProfile} />
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Calibration status</Text>
            <Text style={styles.cardBody}>{calibrationMethodLabel(deviceProfile)}</Text>
            <Text style={styles.smallNote}>{profileConfidenceLabel(deviceProfile)}</Text>
          </View>
          <TouchableOpacity style={styles.primaryButton} onPress={() => { setValidationMessage(null); setPhase('validation'); }}><Text style={styles.primaryButtonText}>Compare with audiologist result</Text></TouchableOpacity>
          <TouchableOpacity style={styles.shareButton} onPress={exportPureTonePdf} disabled={exporting}>{exporting ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.shareButtonText}>Export and share PDF report</Text>}</TouchableOpacity>
          <View style={styles.disclaimerCard}><Text style={styles.disclaimerText}>{deviceProfile?.type === 'acoustic' ? 'Externally measured acoustic calibration profile in use.' : Number(deviceProfile?.clinicalAnchorSessions || 0) > 0 ? 'Clinically anchored research calibration in use; independent validation is still required.' : 'Unanchored biological reference calibration in use; absolute dB-HL bias may remain until paired clinical audiograms are added.'} HearSmart performs unmasked air conduction only and does not replace diagnostic masking, bone conduction, speech audiometry, or professional assessment.</Text></View>
          <TouchableOpacity style={styles.secondaryButton} onPress={resetAll}><Text style={styles.secondaryButtonText}>Start a new test</Text></TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  const currentWindow = ascendingWindowDisplay;
  const heardInWindow = currentWindow.filter(Boolean).length;
  const progress = activeSteps.length ? Math.round((stepIndex / activeSteps.length) * 100) : 0;
  let gainInfo = null;
  try {
    gainInfo = dbHLToAmplitude(currentDb, currentFrequency, deviceProfile, currentEar);
  } catch (_) {}

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.appName}>HearSmart</Text>
        <EarBadge ear={currentEar} />
        <Text style={styles.stepCountText}>Step {stepIndex + 1} of {activeSteps.length}</Text>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%`, backgroundColor: earColor }]} /></View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ width: '100%', marginBottom: 14 }} contentContainerStyle={{ gap: 6 }}>
          {activeSteps.map((item, index) => {
            const done = Boolean(thresholds[currentEar]?.[item.id]);
            const active = index === stepIndex;
            return <View key={item.id} style={[styles.stepChip, done && styles.stepChipDone, active && { borderColor: earColor, backgroundColor: `${earColor}25` }]}><Text style={[styles.stepChipText, (done || active) && { color: '#FFFFFF' }]}>{item.label}{done ? ' ✓' : ''}</Text></View>;
          })}
        </ScrollView>

        {thresholdBanner ? (
          <View style={styles.thresholdBanner}>
            <Text style={styles.thresholdBannerTitle}>Threshold stored</Text>
            <Text style={styles.thresholdBannerFrequency}>{formatFrequency(thresholdBanner.frequency)} · {thresholdBanner.label}</Text>
            <Text style={styles.thresholdBannerValue}>{formatResult(thresholdBanner.result)}</Text>
          </View>
        ) : null}

        <View style={styles.dbCard}>
          <Text style={[styles.levelLabel, { color: earColor }]}>{formatFrequency(currentFrequency)}{currentStep?.id.includes('retest') || currentStep?.id.includes('recheck') ? ' · retest' : ''}</Text>
          <Text style={styles.dbNumber}>{currentDb}</Text>
          <Text style={styles.dbUnit}>{levelUnitLabel(deviceProfile)} · {calibrationMethodLabel(deviceProfile)}</Text>
          {gainInfo ? <Text style={styles.smallNote}>Digital level: {gainInfo.dBFS.toFixed(1)} dBFS{gainInfo.targetSpl == null ? ' · biological reference mapping' : ` · target ${gainInfo.targetSpl.toFixed(1)} dB SPL`}</Text> : null}
          <Text style={styles.directionText}>{!hadDescentDisplay ? 'Initial search' : directionDisplay === 'asc' ? 'Ascending presentation — counts toward threshold' : 'Descending presentation'}</Text>
          {currentWindow.length > 0 ? <View style={[styles.windowBadge, { borderColor: earColor }]}><Text style={{ color: earColor, fontWeight: '700' }}>Ascending responses at this level: {heardInWindow}/{currentWindow.length} heard</Text></View> : null}
          {lastFeedback ? <Text style={{ color: lastFeedback.heard ? '#059669' : '#DC2626', marginTop: 12, fontWeight: '700' }}>{lastFeedback.note ?? `${lastFeedback.heard ? 'Heard' : 'Not heard'} → ${lastFeedback.delta > 0 ? '+' : ''}${lastFeedback.delta} dB`}</Text> : null}
        </View>

        <TouchableOpacity style={[styles.playButton, isPlaying && styles.stopButton, thresholdBanner && styles.disabledButton]} disabled={Boolean(thresholdBanner)} onPress={isPlaying ? cancelPresentation : () => playPureTone(currentFrequency, currentDb, currentEar)}><Text style={styles.playButtonText}>{isPlaying ? 'Stop tone' : tonePlayed ? 'Replay same tone' : 'Present tone'}</Text></TouchableOpacity>
        {tonePlayed && !thresholdBanner ? (
          <View style={styles.responseRow}>
            <TouchableOpacity style={styles.heardButton} onPress={() => handlePureResponse(true)}><Text style={styles.heardButtonText}>✓ I heard it</Text></TouchableOpacity>
            <TouchableOpacity style={styles.notHeardButton} onPress={() => handlePureResponse(false)}><Text style={styles.notHeardButtonText}>Nothing</Text></TouchableOpacity>
          </View>
        ) : null}

        {history.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Current-frequency trial log</Text>
            <View style={styles.logWrap}>{history.map((item, index) => <View key={`${item.stepId}-${index}`} style={[styles.logChip, { backgroundColor: item.heard ? '#064E3B' : '#450A0A' }]}><Text style={{ color: item.heard ? '#6EE7B7' : '#FCA5A5', fontSize: 11 }}>{item.heard ? '✓' : '✗'} {item.db} {item.validAscending ? '↑' : '↓'}</Text></View>)}</View>
          </View>
        ) : null}
        <TouchableOpacity style={styles.resetLink} onPress={resetAll}><Text style={styles.resetLinkText}>Start over</Text></TouchableOpacity>
      </ScrollView>
      {overlay}
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
  audiogramDivider: {
    width: '92%',
    height: 1,
    backgroundColor: '#E2E8F0',
    marginVertical: 4,
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
