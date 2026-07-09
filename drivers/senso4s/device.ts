import Homey from 'homey';
import {
  ANOMALY_NAMES,
  AnomalyType,
  CHAR_CONFIG_UUID,
  CHAR_HISTORY_UUID,
  CHAR_LEVEL_UUID,
  CHAR_SETUP_DATE_UUID,
  DEFAULT_CONNECTION_INTERVAL_MINUTES,
  DEFAULT_GAS_CAPACITY_KG,
  DEFAULT_LOW_LEVEL_THRESHOLD,
  ERROR_DESCRIPTIONS,
  MIN_CONNECTION_INTERVAL_MINUTES,
  PLUS_CHAR_TEMPERATURE_UUID,
  PLUS_SERVICE_UUID,
  SCAN_FILTER_UUID,
  SERVICE_UUID,
  USAGE_MODE_NAMES,
  interpretLevelByte,
  parseAdvertisement,
  parseCylinderConfig,
  parseHistoryData,
  parsePlusTemperature,
  parseSetupDate,
} from '../../lib/senso4s';

const REQUIRED_CAPABILITIES = [
  'measure_battery',
  'alarm_connectivity',
  'alarm_tank_empty',
  'alarm_needs_calibration',
  'alarm_device_error',
  'measure_gas_level',
  'measure_gas_remaining',
  'measure_gas_level_delta',
  'measure_gas_level_delta_hour',
  'measure_rssi',
  'meter_update_method',
];

const PLUS_MODEL_CAPABILITIES = [
  'measure_temperature',
  'alarm_senso_anomaly',
  'alarm_temperature_anomaly',
  'alarm_incline_anomaly',
  'alarm_motion',
];

const MIN_ACTIVE_CONNECTION_RSSI = -85;

const TRUE_ALARM_TRIGGER_BY_CAPABILITY: Record<string, string> = {
  alarm_tank_empty: 'tank_empty',
  alarm_needs_calibration: 'needs_calibration',
  alarm_device_error: 'device_error',
  alarm_senso_anomaly: 'senso_anomaly',
  alarm_temperature_anomaly: 'temperature_anomaly',
  alarm_incline_anomaly: 'incline_anomaly',
  alarm_motion: 'motion_detected',
};

type DeviceSettings = {
  connection_interval_minutes?: number;
  gas_capacity_kg?: number;
  low_level_threshold?: number;
};

type BleAdvertisementLike = {
  uuid: string;
  address: string;
  localName: string;
  rssi: number;
  serviceUuids: string[];
  manufacturerData?: Buffer;
  connect(): Promise<unknown>;
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

module.exports = class Senso4sDevice extends Homey.Device {
  private advertisementTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private unsubscribeAdvertisements: (() => void | Promise<void>) | null = null;
  private isUpdating = false;
  private gasCapacityKg = DEFAULT_GAS_CAPACITY_KG;
  private lowLevelThreshold = DEFAULT_LOW_LEVEL_THRESHOLD;
  private connectionIntervalMinutes = DEFAULT_CONNECTION_INTERVAL_MINUTES;
  private lastDecodedAdvertisementAt = 0;
  private lastHandledSubscriptionAdvertisementAt = 0;
  private lastHandledSubscriptionAdvertisementFingerprint: string | null = null;
  private readonly deprecatedCapabilities = [
    'alarm_battery',
  ];

  async onInit() {
    this.log('Senso4s device initialized', this.getData());
    await this.ensureCapabilities();
    await this.removeDeprecatedCapabilities();
    const store = this.getStore();
    if (typeof store.isPlusModel === 'boolean') {
      await this.syncPlusModelCapabilities(store.isPlusModel);
    }
    this.loadSettings();
    await this.startAdvertisementSubscription();
    await this.updateFromAdvertisement();
    await this.updateFromConnection();
    this.startTimers();
  }

  async onAdded() {
    this.log('Senso4s device has been added');
  }

  async onSettings({
    newSettings,
    changedKeys,
  }: {
    oldSettings: DeviceSettings;
    newSettings: DeviceSettings;
    changedKeys: string[];
  }): Promise<string | void> {
    this.loadSettings(newSettings);

    if (changedKeys.includes('connection_interval_minutes')) {
      this.startTimers();
    }

    await this.recalculateDerivedValues();
  }

  async onRenamed(name: string) {
    this.log('Senso4s device was renamed', name);
  }

  async onDeleted() {
    this.log('Senso4s device has been deleted');
    this.clearTimers();
    await this.stopAdvertisementSubscription();
  }

  private async ensureCapabilities() {
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
      }
    }
  }

  private async removeDeprecatedCapabilities() {
    for (const capability of this.deprecatedCapabilities) {
      if (this.hasCapability(capability)) {
        this.log(`Removing deprecated capability ${capability}`);
        await this.removeCapability(capability);
      }
    }
  }

  private async syncPlusModelCapabilities(isPlusModel: boolean) {
    for (const capability of PLUS_MODEL_CAPABILITIES) {
      if (isPlusModel && !this.hasCapability(capability)) {
        this.log(`Adding Plus capability ${capability}`);
        await this.addCapability(capability);
      } else if (!isPlusModel && this.hasCapability(capability)) {
        this.log(`Removing Plus capability ${capability}`);
        await this.removeCapability(capability);
      }
    }
  }

  private loadSettings(settings: DeviceSettings = this.getSettings() as DeviceSettings) {
    this.connectionIntervalMinutes = Math.max(
      MIN_CONNECTION_INTERVAL_MINUTES,
      Number(settings.connection_interval_minutes) || DEFAULT_CONNECTION_INTERVAL_MINUTES,
    );
    this.gasCapacityKg = Number(settings.gas_capacity_kg) || DEFAULT_GAS_CAPACITY_KG;
    this.lowLevelThreshold = Number(settings.low_level_threshold) || DEFAULT_LOW_LEVEL_THRESHOLD;
  }

  private startTimers() {
    this.clearTimers();
    this.advertisementTimer = this.homey.setInterval(
      () => this.updateFromAdvertisement().catch((error) => this.error('Advertisement update failed', error)),
      this.unsubscribeAdvertisements ? 10 * 60 * 1000 : 60 * 1000,
    );
    this.connectionTimer = this.homey.setInterval(
      () => this.updateFromConnection().catch((error) => this.error('Connected update failed', error)),
      this.connectionIntervalMinutes * 60 * 1000,
    );
  }

  private async startAdvertisementSubscription() {
    if (this.unsubscribeAdvertisements) {
      return;
    }

    const homeyWithFeatures = this.homey as typeof this.homey & {
      hasFeature?: (feature: string) => boolean;
    };
    const supportsAdvertisementSubscriptions = homeyWithFeatures.hasFeature?.('ble-advertisements') === true;

    if (!supportsAdvertisementSubscriptions) {
      this.log('BLE advertisement subscriptions are not supported on this Homey, using find/discover fallback');
      return;
    }

    const ble = this.homey.ble as typeof this.homey.ble & {
      subscribeToAdvertisements?: (
        serviceFilter: string[],
        callback: (advertisement: BleAdvertisementLike) => void | Promise<void>,
      ) => Promise<() => void | Promise<void>> | (() => void | Promise<void>);
    };

    if (typeof ble.subscribeToAdvertisements !== 'function') {
      this.log('Homey reports ble-advertisements support, but subscribeToAdvertisements is unavailable in this SDK runtime');
      return;
    }

    const unsubscribe = await ble.subscribeToAdvertisements([SCAN_FILTER_UUID], async (advertisement) => {
      if (!this.isAdvertisementForThisDevice(advertisement)) {
        return;
      }

      await this.handleAdvertisement(advertisement, 'subscription');
    });

    this.unsubscribeAdvertisements = unsubscribe;
    this.log('Subscribed to Senso4s BLE advertisements');
  }

  private async stopAdvertisementSubscription() {
    if (!this.unsubscribeAdvertisements) {
      return;
    }

    const unsubscribe = this.unsubscribeAdvertisements;
    this.unsubscribeAdvertisements = null;
    await unsubscribe();
  }

  private clearTimers() {
    if (this.advertisementTimer) {
      this.homey.clearInterval(this.advertisementTimer);
      this.advertisementTimer = null;
    }

    if (this.connectionTimer) {
      this.homey.clearInterval(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private async findAdvertisement() {
    const store = this.getStore();
    const uuid = typeof store.peripheralUuid === 'string' ? store.peripheralUuid : this.getData().id;

    try {
      return await this.homey.ble.find(uuid);
    } catch (error) {
      this.log(`BLE find failed for ${uuid}, scanning for Senso4s advertisement fallback`);
    }

    const targetAddress = String(store.address || this.getData().id || '').toUpperCase();
    const advertisements = await this.homey.ble.discover([SCAN_FILTER_UUID]);
    const advertisement = advertisements.find((item) => {
      const address = String(item.address || '').toUpperCase();
      const parsed = parseAdvertisement(item);
      return item.uuid === uuid || address === targetAddress || parsed?.macAddress === targetAddress;
    });

    if (!advertisement) {
      throw new Error(`Senso4s advertisement not found for ${uuid}`);
    }

    if (advertisement.uuid !== uuid) {
      await this.setStoreValue('peripheralUuid', advertisement.uuid).catch(() => undefined);
    }

    return advertisement;
  }

  private isAdvertisementForThisDevice(advertisement: BleAdvertisementLike) {
    const store = this.getStore();
    const targetUuid = typeof store.peripheralUuid === 'string' ? store.peripheralUuid : undefined;
    const targetAddress = String(store.address || this.getData().id || '').toUpperCase();
    const address = String(advertisement.address || '').toUpperCase();
    const parsed = parseAdvertisement(advertisement);

    return advertisement.uuid === targetUuid || address === targetAddress || parsed?.macAddress === targetAddress;
  }

  private async updateFromAdvertisement() {
    try {
      const advertisement = await this.findAdvertisement();
      await this.handleAdvertisement(advertisement, 'poll');
    } catch (error) {
      this.error('Could not read Senso4s advertisement', error);
      await this.setCapabilityValueIfChanged('alarm_connectivity', true).catch(this.error);
    }
  }

  private async handleAdvertisement(
    advertisement: BleAdvertisementLike,
    source: 'poll' | 'subscription',
  ) {
    if (source === 'subscription' && !this.shouldHandleSubscriptionAdvertisement(advertisement)) {
      return;
    }

    const parsed = parseAdvertisement(advertisement);

    this.log('Advertisement raw', JSON.stringify({
      source,
      uuid: advertisement.uuid,
      address: advertisement.address,
      localName: advertisement.localName,
      rssi: advertisement.rssi,
      serviceUuids: advertisement.serviceUuids,
      manufacturerData: advertisement.manufacturerData?.toString('hex') || null,
    }));

    await this.setCapabilityValueIfChanged('alarm_connectivity', false);
    await this.setCapabilityValueIfChanged('measure_rssi', advertisement.rssi);
    await this.setUpdateMethod('Advertisements');

    if (parsed) {
      this.lastDecodedAdvertisementAt = Date.now();
      this.log('Advertisement decoded', JSON.stringify(this.summarizeParsedAdvertisement(parsed)));
      await this.applyParsedData(parsed);
    } else {
      const store = this.getStore();
      if (store.isPlusModel === false) {
        await this.syncPlusModelCapabilities(false);
      }
      this.log('Advertisement did not contain decodable Senso4s manufacturer data');
    }
  }

  private async updateFromConnection() {
    if (this.isUpdating) {
      return;
    }

    this.isUpdating = true;
    let peripheral: Awaited<ReturnType<Awaited<ReturnType<typeof this.findAdvertisement>>['connect']>> | null = null;

    try {
      const advertisement = await this.findAdvertisement();
      this.log('Connecting for active BLE read', JSON.stringify({
        uuid: advertisement.uuid,
        address: advertisement.address,
        rssi: advertisement.rssi,
      }));

      if (advertisement.rssi <= MIN_ACTIVE_CONNECTION_RSSI) {
        this.log(`Skipping active BLE read because RSSI is too low (${advertisement.rssi} dBm); gas capacity remains ${this.gasCapacityKg} kg until config can be read`);
        await this.setUpdateMethod(this.hasFreshDecodedAdvertisement()
          ? 'Advertisements'
          : 'Waiting for advertisement');
        return;
      }

      peripheral = await advertisement.connect();
      await this.setCapabilityValueIfChanged('alarm_connectivity', false);
      await this.setUpdateMethod('Active read');

      const config = await peripheral.read(SERVICE_UUID, CHAR_CONFIG_UUID)
        .then((data: Buffer) => {
          const configValue = parseCylinderConfig(data);
          this.log('Config characteristic', JSON.stringify({
            uuid: CHAR_CONFIG_UUID,
            raw: data.toString('hex'),
            decoded: configValue ? {
              emptyWeightKg: configValue.emptyWeightKg,
              gasCapacityKg: configValue.gasCapacityKg,
              usageMode: USAGE_MODE_NAMES[configValue.usageMode],
            } : null,
          }));
          return configValue;
        })
        .catch((error: Error) => {
          this.log('Could not read Senso4s config characteristic', error.message);
          return null;
        });

      if (config?.gasCapacityKg) {
        this.gasCapacityKg = config.gasCapacityKg;
        await this.setSettings({ gas_capacity_kg: config.gasCapacityKg }).catch((error: Error) => {
          this.log('Could not persist gas capacity setting', error.message);
        });
      }

      const levelByte = await this.readLevelByte(peripheral);
      if (typeof levelByte === 'number') {
        const level = interpretLevelByte(levelByte);
        this.log('Level decoded', JSON.stringify({
          rawByte: `0x${levelByte.toString(16).padStart(2, '0')}`,
          level: this.summarizeLevel(level),
        }));
        await this.applyLevelInterpretation(level);
      }

      if (this.getStore().isPlusModel === true) {
        await this.readPlusTemperature(peripheral);
      }

      const setupDate = await peripheral.read(SERVICE_UUID, CHAR_SETUP_DATE_UUID)
        .then((data: Buffer) => {
          const setupDateValue = parseSetupDate(data);
          this.log('Setup date characteristic', JSON.stringify({
            uuid: CHAR_SETUP_DATE_UUID,
            raw: data.toString('hex'),
            decoded: setupDateValue?.toISOString() || null,
          }));
          return setupDateValue;
        })
        .catch((error: Error) => {
          this.log('Could not read Senso4s setup date characteristic', error.message);
          return null;
        });

      if (setupDate) {
        const history = await this.readHistory(peripheral, setupDate);
        const latest = history[history.length - 1];
        this.log('History decoded', JSON.stringify({
          records: history.length,
          latest: latest ? {
            remainingGasKg: latest.remainingGasKg,
            timestamp: latest.timestamp.toISOString(),
          } : null,
        }));
        if (latest) {
          await this.setCapabilityValueIfChanged('measure_gas_remaining', round(latest.remainingGasKg, 2));
        }
      }
    } catch (error) {
      this.error('Could not connect to Senso4s device', error);
      await this.setCapabilityValueIfChanged('alarm_connectivity', true).catch(this.error);
    } finally {
      if (peripheral) {
        await peripheral.disconnect().catch((error: Error) => this.log('Disconnect failed', error.message));
      }
      this.isUpdating = false;
    }
  }

  private async readLevelByte(peripheral: Awaited<ReturnType<Awaited<ReturnType<typeof this.findAdvertisement>>['connect']>>) {
    const direct = await peripheral.read(SERVICE_UUID, CHAR_LEVEL_UUID)
      .then((data: Buffer) => {
        this.log('Level characteristic direct read', JSON.stringify({
          uuid: CHAR_LEVEL_UUID,
          raw: data.toString('hex'),
        }));
        return data.length > 0 ? data[0] : null;
      })
      .catch((error: Error) => {
        this.log('Could not read Senso4s level characteristic directly', error.message);
        return null;
      });

    if (typeof direct === 'number') {
      return direct;
    }

    const service = await peripheral.getService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(CHAR_LEVEL_UUID);

    return new Promise<number | null>((resolve) => {
      const timeout = this.homey.setTimeout(async () => {
        await characteristic.unsubscribeFromNotifications().catch(() => undefined);
        resolve(null);
      }, 5000);

      characteristic.subscribeToNotifications(async (data: Buffer) => {
        if (data.length > 0) {
          this.log('Level notification', JSON.stringify({
            uuid: CHAR_LEVEL_UUID,
            raw: data.toString('hex'),
          }));
          this.homey.clearTimeout(timeout);
          await characteristic.unsubscribeFromNotifications().catch(() => undefined);
          resolve(data[0]);
        }
      }).catch(() => {
        this.homey.clearTimeout(timeout);
        resolve(null);
      });
    });
  }

  private async readPlusTemperature(peripheral: Awaited<ReturnType<Awaited<ReturnType<typeof this.findAdvertisement>>['connect']>>) {
    await peripheral.read(PLUS_SERVICE_UUID, PLUS_CHAR_TEMPERATURE_UUID)
      .then(async (data: Buffer) => {
        const temperature = parsePlusTemperature(data);
        this.log('Plus temperature characteristic', JSON.stringify({
          uuid: PLUS_CHAR_TEMPERATURE_UUID,
          raw: data.toString('hex'),
          decoded: temperature,
        }));
        if (typeof temperature === 'number') {
          await this.setCapabilityValueIfChanged('measure_temperature', temperature);
        }
      })
      .catch((error: Error) => {
        this.log('Could not read Senso4s Plus temperature characteristic', error.message);
      });
  }

  private async readHistory(
    peripheral: Awaited<ReturnType<Awaited<ReturnType<typeof this.findAdvertisement>>['connect']>>,
    setupDate: Date,
  ) {
    const service = await peripheral.getService(SERVICE_UUID);
    const characteristic = await service.getCharacteristic(CHAR_HISTORY_UUID);
    const chunks: Buffer[] = [];

    return new Promise<ReturnType<typeof parseHistoryData>>((resolve) => {
      let quietTimer: NodeJS.Timeout | null = null;
      const finish = async () => {
        if (quietTimer) {
          this.homey.clearTimeout(quietTimer);
          quietTimer = null;
        }
        await characteristic.unsubscribeFromNotifications().catch(() => undefined);
        const raw = Buffer.concat(chunks);
        this.log('History characteristic raw', JSON.stringify({
          uuid: CHAR_HISTORY_UUID,
          bytes: raw.length,
          raw: raw.toString('hex'),
        }));
        resolve(parseHistoryData(raw, setupDate));
      };

      const timeout = this.homey.setTimeout(finish, 5000);
      characteristic.subscribeToNotifications((data: Buffer) => {
        if (data.length > 0) {
          this.log('History notification chunk', JSON.stringify({
            uuid: CHAR_HISTORY_UUID,
            raw: data.toString('hex'),
          }));
          chunks.push(data);
          if (quietTimer) {
            this.homey.clearTimeout(quietTimer);
          }
          quietTimer = this.homey.setTimeout(() => {
            this.homey.clearTimeout(timeout);
            finish().catch((error) => this.error('History finish failed', error));
          }, 1000);
        }
      }).then(() => characteristic.write(Buffer.from([0x00, 0x00]))).catch(() => {
        this.homey.clearTimeout(timeout);
        resolve([]);
      });
    });
  }

  private async applyParsedData(parsed: NonNullable<ReturnType<typeof parseAdvertisement>>) {
    await this.syncPlusModelCapabilities(parsed.isPlusModel);
    await this.setStoreValue('isPlusModel', parsed.isPlusModel).catch(() => undefined);
    await this.setStoreValue('usageMode', USAGE_MODE_NAMES[parsed.usageMode]).catch(() => undefined);
    await this.setStoreValue('anomalies', parsed.anomalies.map((anomaly) => ANOMALY_NAMES[anomaly])).catch(() => undefined);
    await this.setStoreValue('errorDescription', parsed.errorCode ? ERROR_DESCRIPTIONS[parsed.errorCode] : null).catch(() => undefined);

    await this.setCapabilityValueIfChanged('measure_battery', parsed.batteryPercent);
    if (parsed.errorCode === 0xfe) {
      await this.setCapabilityValueIfChanged('measure_battery', 0);
    }
    await this.applyLevelInterpretation(parsed);
  }

  private async applyLevelInterpretation(level: {
    gasLevelPercent: number | null;
    needsCalibration: boolean;
    hasError: boolean;
    errorCode?: number | null;
    anomalies: AnomalyType[];
  }) {
    await this.setCapabilityValueIfChanged('alarm_needs_calibration', level.needsCalibration);
    await this.setCapabilityValueIfChanged('alarm_device_error', level.hasError);

    if (this.hasCapability('alarm_senso_anomaly')) {
      await this.setCapabilityValueIfChanged('alarm_senso_anomaly', level.anomalies.length > 0);
    }
    if (this.hasCapability('alarm_temperature_anomaly')) {
      await this.setCapabilityValueIfChanged('alarm_temperature_anomaly', level.anomalies.includes(AnomalyType.TEMPERATURE));
    }
    if (this.hasCapability('alarm_incline_anomaly')) {
      await this.setCapabilityValueIfChanged('alarm_incline_anomaly', level.anomalies.includes(AnomalyType.INCLINE));
    }
    if (this.hasCapability('alarm_motion')) {
      await this.setCapabilityValueIfChanged('alarm_motion', level.anomalies.includes(AnomalyType.MOTION));
    }

    if (typeof level.gasLevelPercent === 'number') {
      await this.updateGasLevelDelta(level.gasLevelPercent);
      await this.setCapabilityValueIfChanged('measure_gas_level', level.gasLevelPercent);
      await this.recalculateDerivedValues(level.gasLevelPercent);
    }
  }

  private async updateGasLevelDelta(gasLevelPercent: number) {
    const store = this.getStore();
    const previousGasLevel = typeof store.lastGasLevelPercent === 'number'
      ? store.lastGasLevelPercent
      : null;
    const previousTimestamp = typeof store.lastGasLevelAt === 'number'
      ? store.lastGasLevelAt
      : null;
    const now = Date.now();

    if (previousGasLevel === null || previousTimestamp === null) {
      await this.setStoreValue('lastGasLevelPercent', gasLevelPercent).catch(() => undefined);
      await this.setStoreValue('lastGasLevelAt', now).catch(() => undefined);
      return;
    }

    if (previousGasLevel === gasLevelPercent) {
      return;
    }

    const delta = gasLevelPercent - previousGasLevel;
    const elapsedHours = Math.max((now - previousTimestamp) / 3600000, 1 / 60);
    const deltaPerHour = delta / elapsedHours;

    this.log('Gas level change', JSON.stringify({
      previousGasLevelPercent: previousGasLevel,
      gasLevelPercent,
      deltaPercentPoints: delta,
      elapsedHours: round(elapsedHours, 3),
      deltaPercentPointsPerHour: round(deltaPerHour, 2),
    }));

    await this.setCapabilityValueIfChanged('measure_gas_level_delta', delta);
    await this.setCapabilityValueIfChanged('measure_gas_level_delta_hour', round(deltaPerHour, 2));
    await this.triggerGasLevelChangedFlow({
      gas_level: gasLevelPercent,
      previous_gas_level: previousGasLevel,
      delta,
      delta_per_hour: round(deltaPerHour, 2),
      elapsed_hours: round(elapsedHours, 2),
    });
    await this.setStoreValue('lastGasLevelPercent', gasLevelPercent).catch(() => undefined);
    await this.setStoreValue('lastGasLevelAt', now).catch(() => undefined);
  }

  private async recalculateDerivedValues(gasLevel = this.getCapabilityValue('measure_gas_level')) {
    if (typeof gasLevel !== 'number') {
      return;
    }

    await this.setCapabilityValueIfChanged('measure_gas_remaining', round((gasLevel / 100) * this.gasCapacityKg, 2));
    await this.setCapabilityValueIfChanged('alarm_tank_empty', gasLevel <= this.lowLevelThreshold);
  }

  private summarizeParsedAdvertisement(parsed: NonNullable<ReturnType<typeof parseAdvertisement>>) {
    const level = this.summarizeLevel(parsed);
    return {
      manufacturerId: parsed.manufacturerId ? `0x${parsed.manufacturerId.toString(16).padStart(4, '0')}` : null,
      macAddress: parsed.macAddress,
      model: parsed.isPlusModel ? 'Plus' : 'Basic',
      usageMode: USAGE_MODE_NAMES[parsed.usageMode],
      batteryPercent: parsed.batteryPercent,
      gasLevelPercent: level.gasLevelPercent,
      needsCalibration: level.needsCalibration,
      hasError: level.hasError,
      errorCode: level.errorCode,
      errorDescription: level.errorDescription,
      anomalies: level.anomalies,
    };
  }

  private summarizeLevel(level: {
    gasLevelPercent: number | null;
    needsCalibration: boolean;
    hasError: boolean;
    errorCode: number | null;
    anomalies: AnomalyType[];
  }) {
    return {
      gasLevelPercent: level.gasLevelPercent,
      needsCalibration: level.needsCalibration,
      hasError: level.hasError,
      errorCode: level.errorCode,
      errorDescription: level.errorCode ? ERROR_DESCRIPTIONS[level.errorCode] : null,
      anomalies: level.anomalies.map((anomaly) => ANOMALY_NAMES[anomaly]),
    };
  }

  private hasFreshDecodedAdvertisement() {
    return Date.now() - this.lastDecodedAdvertisementAt < this.connectionIntervalMinutes * 60 * 1000;
  }

  private shouldHandleSubscriptionAdvertisement(advertisement: BleAdvertisementLike) {
    const now = Date.now();
    const fingerprint = [
      advertisement.uuid,
      advertisement.address,
      advertisement.manufacturerData?.toString('hex') || '',
    ].join('|');

    if (
      fingerprint === this.lastHandledSubscriptionAdvertisementFingerprint
      && now - this.lastHandledSubscriptionAdvertisementAt < 60 * 1000
    ) {
      return false;
    }

    this.lastHandledSubscriptionAdvertisementFingerprint = fingerprint;
    this.lastHandledSubscriptionAdvertisementAt = now;
    return true;
  }

  private async setUpdateMethod(method: string) {
    await this.setCapabilityValueIfChanged('meter_update_method', method);
  }

  private async setCapabilityValueIfChanged(capability: string, value: boolean | number | string | null) {
    if (!this.hasCapability(capability)) {
      return;
    }

    const previousValue = this.getCapabilityValue(capability);
    if (previousValue === value) {
      return;
    }

    await this.setCapabilityValue(capability, value);
    await this.triggerAlarmFlowIfNeeded(capability, value);
  }

  private async triggerAlarmFlowIfNeeded(capability: string, value: boolean | number | string | null) {
    if (value !== true) {
      return;
    }

    const triggerId = TRUE_ALARM_TRIGGER_BY_CAPABILITY[capability];
    if (!triggerId) {
      return;
    }

    await this.homey.flow.getDeviceTriggerCard(triggerId).trigger(this, {}, {}).catch(this.error);
  }

  private async triggerGasLevelChangedFlow(tokens: {
    gas_level: number;
    previous_gas_level: number;
    delta: number;
    delta_per_hour: number;
    elapsed_hours: number;
  }) {
    await this.homey.flow.getDeviceTriggerCard('gas_level_changed').trigger(this, tokens, {}).catch(this.error);
  }

};
