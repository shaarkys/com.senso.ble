/*
 * Senso4s BLE protocol helpers for Homey.
 *
 * Adapted from the Senso4s Home Assistant integration:
 * https://github.com/ksanislo/senso4s_ble
 *
 * Original work Copyright 2026 Ken Sanislo, licensed under Apache-2.0.
 * This TypeScript/Homey port modifies the parser and BLE handling for
 * Homey SDK 3 capabilities, pairing, and polling.
 */

export const SERVICE_UUID = '00007081a20b4d4da4de7f071dbbc1d8';
export const PLUS_SERVICE_UUID = '0000188123b39a14a4ae71a713cb89a8';
export const SCAN_FILTER_UUID = '0000708100001000800000805f9b34fb';
export const CHAR_LEVEL_UUID = '00007082a20b4d4da4de7f071dbbc1d8';
export const CHAR_CONFIG_UUID = '00007083a20b4d4da4de7f071dbbc1d8';
export const CHAR_HISTORY_UUID = '00007085a20b4d4da4de7f071dbbc1d8';
export const CHAR_SETUP_DATE_UUID = '00007087a20b4d4da4de7f071dbbc1d8';
export const PLUS_CHAR_TEMPERATURE_UUID = '0000188223b39a14a4ae71a713cb89a8';

export const MANUFACTURER_IDS = new Set([0x0059, 0x09cc]);
export const DEVICE_NAME_PREFIX = 'SENSO4S';
export const DEFAULT_GAS_CAPACITY_KG = 11;
export const DEFAULT_LOW_LEVEL_THRESHOLD = 10;
export const DEFAULT_CONNECTION_INTERVAL_MINUTES = 15;
export const MIN_CONNECTION_INTERVAL_MINUTES = 5;
export const CYCLE_DURATION_MINUTES = 15;

export enum UsageMode {
  BBQ = 1,
  CAMPING = 2,
  CARAVANNING = 3,
  HEATING = 4,
  HOUSEHOLD = 5,
}

export enum AnomalyType {
  TEMPERATURE = 1,
  INCLINE = 2,
  MOTION = 4,
}

export const USAGE_MODE_NAMES: Record<UsageMode, string> = {
  [UsageMode.BBQ]: 'BBQ',
  [UsageMode.CAMPING]: 'Camping',
  [UsageMode.CARAVANNING]: 'Caravanning',
  [UsageMode.HEATING]: 'Heating',
  [UsageMode.HOUSEHOLD]: 'Household',
};

export const ANOMALY_NAMES: Record<AnomalyType, string> = {
  [AnomalyType.TEMPERATURE]: 'Temperature',
  [AnomalyType.INCLINE]: 'Incline',
  [AnomalyType.MOTION]: 'Motion',
};

export const ERROR_DESCRIPTIONS: Record<number, string> = {
  0xfc: 'Setup error: check cylinder weight and gas capacity',
  0xfe: 'Batteries empty: replacement required',
  0xff: 'Device not ready: zeroing required',
};

export type LevelInterpretation = {
  gasLevelPercent: number | null;
  needsCalibration: boolean;
  hasError: boolean;
  errorCode: number | null;
  anomalies: AnomalyType[];
};

export type Senso4sAdvertisementData = LevelInterpretation & {
  manufacturerId: number;
  macAddress: string;
  name: string;
  batteryPercent: number;
  usageMode: UsageMode;
  isPlusModel: boolean;
};

export type CylinderConfig = {
  emptyWeightKg: number;
  gasCapacityKg: number;
  usageMode: UsageMode;
};

export type HistoryRecord = {
  remainingGasKg: number;
  timestamp: Date;
};

export function normalizeUuid(uuid: string): string {
  return uuid.toLowerCase().replace(/-/g, '');
}

export function normalizeAddress(address: string | undefined): string {
  return (address || '').toUpperCase();
}

export function isSenso4sAdvertisement(advertisement: {
  localName?: string;
  manufacturerData?: Buffer;
  serviceUuids?: string[];
}): boolean {
  if (parseAdvertisement(advertisement) !== null) {
    return true;
  }

  const name = advertisement.localName || '';
  const serviceUuids = advertisement.serviceUuids || [];
  return name.toUpperCase().startsWith(DEVICE_NAME_PREFIX)
    || serviceUuids.some((uuid) => normalizeUuid(uuid) === SCAN_FILTER_UUID);
}

export function parseAdvertisement(advertisement: {
  localName?: string;
  serviceUuids?: string[];
  manufacturerData?: Buffer;
}): Senso4sAdvertisementData | null {
  const { manufacturerData } = advertisement;
  if (!manufacturerData || manufacturerData.length < 11) {
    return null;
  }

  let manufacturerId = 0;
  let data = manufacturerData;

  if (manufacturerData.length >= 13) {
    const possibleManufacturerId = manufacturerData.readUInt16LE(0);
    if (MANUFACTURER_IDS.has(possibleManufacturerId)) {
      manufacturerId = possibleManufacturerId;
      data = manufacturerData.subarray(2);
    }
  }

  if (manufacturerId === 0 && !hasSensoIdentity(advertisement)) {
    return null;
  }

  if (data.length < 11) {
    return null;
  }

  const flagsByte = data[0];
  const levelByte = data[1];
  const batteryPercent = clamp(data[4], 0, 100);
  const macBytes = data.length >= 12 ? data.subarray(6, 12) : Buffer.alloc(6);
  const modelNibble = flagsByte >> 4;
  const isPlusModel = modelNibble < 0x8;
  const usageMode = usageModeFromValue(flagsByte & 0x0f);

  const anomalies: AnomalyType[] = [];
  if (isPlusModel && modelNibble !== 0) {
    for (const anomaly of [AnomalyType.TEMPERATURE, AnomalyType.INCLINE, AnomalyType.MOTION]) {
      if ((modelNibble & anomaly) !== 0) {
        anomalies.push(anomaly);
      }
    }
  }

  const level = interpretLevelByte(levelByte);
  for (const anomaly of level.anomalies) {
    if (!anomalies.includes(anomaly)) {
      anomalies.push(anomaly);
    }
  }

  return {
    gasLevelPercent: level.gasLevelPercent,
    needsCalibration: level.needsCalibration,
    hasError: level.hasError,
    errorCode: level.errorCode,
    anomalies,
    manufacturerId,
    macAddress: Array.from(macBytes).map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(':'),
    name: advertisement.localName || DEVICE_NAME_PREFIX,
    batteryPercent,
    usageMode,
    isPlusModel,
  };
}

function hasSensoIdentity(advertisement: {
  localName?: string;
  serviceUuids?: string[];
}): boolean {
  const name = advertisement.localName || '';
  const serviceUuids = advertisement.serviceUuids || [];
  return name.toUpperCase().startsWith(DEVICE_NAME_PREFIX)
    || serviceUuids.some((uuid) => normalizeUuid(uuid) === SCAN_FILTER_UUID);
}

export function interpretLevelByte(levelByte: number): LevelInterpretation {
  if (levelByte <= 100) {
    return {
      gasLevelPercent: levelByte,
      needsCalibration: false,
      hasError: false,
      errorCode: null,
      anomalies: [],
    };
  }

  if (levelByte === 0xff) {
    return {
      gasLevelPercent: null,
      needsCalibration: true,
      hasError: false,
      errorCode: null,
      anomalies: [],
    };
  }

  if (levelByte === 0xfc || levelByte === 0xfe) {
    return {
      gasLevelPercent: null,
      needsCalibration: false,
      hasError: true,
      errorCode: levelByte,
      anomalies: [],
    };
  }

  if (levelByte >= 241 && levelByte <= 247) {
    const flags = levelByte - 240;
    return {
      gasLevelPercent: null,
      needsCalibration: false,
      hasError: false,
      errorCode: null,
      anomalies: [AnomalyType.TEMPERATURE, AnomalyType.INCLINE, AnomalyType.MOTION]
        .filter((anomaly) => (flags & anomaly) !== 0),
    };
  }

  return {
    gasLevelPercent: null,
    needsCalibration: false,
    hasError: false,
    errorCode: null,
    anomalies: [],
  };
}

export function parseCylinderConfig(data: Buffer): CylinderConfig | null {
  if (data.length !== 5) {
    return null;
  }

  return {
    emptyWeightKg: data.readUInt16LE(0) / 100,
    gasCapacityKg: data.readUInt16LE(2) / 100,
    usageMode: usageModeFromValue(data[4]),
  };
}

export function parsePlusTemperature(data: Buffer): number | null {
  if (data.length < 1) {
    return null;
  }

  return data[0] - 100;
}

export function parseSetupDate(data: Buffer): Date | null {
  if (data.length !== 7 || data.every((byte) => byte === 0)) {
    return null;
  }

  const year = data.readUInt16LE(0);
  const month = data[2];
  const day = data[3];
  const hour = data[4];
  const minute = data[5];
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date;
}

export function parseHistoryData(data: Buffer, setupDate: Date): HistoryRecord[] {
  if (data.length % 4 !== 0) {
    return [];
  }

  const records: HistoryRecord[] = [];
  let cumulativeCycles = 0;

  for (let index = 0; index < data.length; index += 4) {
    const remainingGasKg = data.readUInt16LE(index) / 100;
    const cycles = data.readUInt16LE(index + 2);

    if (index === 0 && cycles !== 0) {
      records.push({
        remainingGasKg,
        timestamp: new Date(setupDate.getTime()),
      });
    }

    cumulativeCycles += cycles;
    records.push({
      remainingGasKg,
      timestamp: new Date(setupDate.getTime() + cumulativeCycles * CYCLE_DURATION_MINUTES * 60 * 1000),
    });
  }

  return records;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function usageModeFromValue(value: number): UsageMode {
  if (Object.values(UsageMode).includes(value)) {
    return value as UsageMode;
  }

  return UsageMode.HOUSEHOLD;
}
