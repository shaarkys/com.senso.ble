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
  SERVICE_UUID,
  USAGE_MODE_NAMES,
  interpretLevelByte,
  parseAdvertisement,
  parseCylinderConfig,
  parseHistoryData,
  parseSetupDate,
} from '../../lib/senso4s';

const REQUIRED_CAPABILITIES = [
  'measure_battery',
  'alarm_battery',
  'alarm_connectivity',
  'alarm_tank_empty',
  'alarm_needs_calibration',
  'alarm_device_error',
  'measure_gas_level',
  'measure_gas_remaining',
  'measure_rssi',
];

const PLUS_MODEL_CAPABILITIES = [
  'alarm_senso_anomaly',
  'alarm_temperature_anomaly',
  'alarm_incline_anomaly',
  'alarm_motion',
];

type DeviceSettings = {
  connection_interval_minutes?: number;
  gas_capacity_kg?: number;
  low_level_threshold?: number;
};

module.exports = class Senso4sDevice extends Homey.Device {
  private advertisementTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private isUpdating = false;
  private gasCapacityKg = DEFAULT_GAS_CAPACITY_KG;
  private lowLevelThreshold = DEFAULT_LOW_LEVEL_THRESHOLD;
  private connectionIntervalMinutes = DEFAULT_CONNECTION_INTERVAL_MINUTES;

  async onInit() {
    this.log('Senso4s device initialized', this.getData());
    await this.ensureCapabilities();
    this.loadSettings();
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
  }

  private async ensureCapabilities() {
    for (const capability of REQUIRED_CAPABILITIES) {
      if (!this.hasCapability(capability)) {
        await this.addCapability(capability);
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
      60 * 1000,
    );
    this.connectionTimer = this.homey.setInterval(
      () => this.updateFromConnection().catch((error) => this.error('Connected update failed', error)),
      this.connectionIntervalMinutes * 60 * 1000,
    );
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
    return this.homey.ble.find(uuid);
  }

  private async updateFromAdvertisement() {
    try {
      const advertisement = await this.findAdvertisement();
      const parsed = parseAdvertisement(advertisement);

      this.log('Advertisement raw', JSON.stringify({
        uuid: advertisement.uuid,
        address: advertisement.address,
        localName: advertisement.localName,
        rssi: advertisement.rssi,
        serviceUuids: advertisement.serviceUuids,
        manufacturerData: advertisement.manufacturerData?.toString('hex') || null,
      }));

      await this.setCapabilityValue('alarm_connectivity', false);
      await this.setCapabilityValue('measure_rssi', advertisement.rssi);

      if (parsed) {
        this.log('Advertisement decoded', JSON.stringify(this.summarizeParsedAdvertisement(parsed)));
        await this.applyParsedData(parsed);
      } else {
        this.log('Advertisement did not contain decodable Senso4s manufacturer data');
      }
    } catch (error) {
      this.error('Could not read Senso4s advertisement', error);
      await this.setCapabilityValue('alarm_connectivity', true).catch(this.error);
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
      peripheral = await advertisement.connect();
      await this.setCapabilityValue('alarm_connectivity', false);

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
          ...this.summarizeLevel(level),
        }));
        await this.applyLevelInterpretation(level);
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
          await this.setCapabilityValue('measure_gas_remaining', round(latest.remainingGasKg, 2));
        }
      }
    } catch (error) {
      this.error('Could not connect to Senso4s device', error);
      await this.setCapabilityValue('alarm_connectivity', true).catch(this.error);
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

    await this.setCapabilityValue('measure_battery', parsed.batteryPercent);
    await this.setCapabilityValue('alarm_battery', parsed.batteryPercent <= 10);
    await this.applyLevelInterpretation(parsed);
  }

  private async applyLevelInterpretation(level: {
    gasLevelPercent: number | null;
    needsCalibration: boolean;
    hasError: boolean;
    anomalies: AnomalyType[];
  }) {
    await this.setCapabilityValue('alarm_needs_calibration', level.needsCalibration);
    await this.setCapabilityValue('alarm_device_error', level.hasError);

    if (this.hasCapability('alarm_senso_anomaly')) {
      await this.setCapabilityValue('alarm_senso_anomaly', level.anomalies.length > 0);
    }
    if (this.hasCapability('alarm_temperature_anomaly')) {
      await this.setCapabilityValue('alarm_temperature_anomaly', level.anomalies.includes(AnomalyType.TEMPERATURE));
    }
    if (this.hasCapability('alarm_incline_anomaly')) {
      await this.setCapabilityValue('alarm_incline_anomaly', level.anomalies.includes(AnomalyType.INCLINE));
    }
    if (this.hasCapability('alarm_motion')) {
      await this.setCapabilityValue('alarm_motion', level.anomalies.includes(AnomalyType.MOTION));
    }

    if (typeof level.gasLevelPercent === 'number') {
      await this.setCapabilityValue('measure_gas_level', level.gasLevelPercent);
      await this.recalculateDerivedValues(level.gasLevelPercent);
    }
  }

  private async recalculateDerivedValues(gasLevel = this.getCapabilityValue('measure_gas_level')) {
    if (typeof gasLevel !== 'number') {
      return;
    }

    await this.setCapabilityValue('measure_gas_remaining', round((gasLevel / 100) * this.gasCapacityKg, 2));
    await this.setCapabilityValue('alarm_tank_empty', gasLevel <= this.lowLevelThreshold);
  }

  private summarizeParsedAdvertisement(parsed: NonNullable<ReturnType<typeof parseAdvertisement>>) {
    return {
      manufacturerId: parsed.manufacturerId ? `0x${parsed.manufacturerId.toString(16).padStart(4, '0')}` : null,
      macAddress: parsed.macAddress,
      model: parsed.isPlusModel ? 'Plus' : 'Basic',
      usageMode: USAGE_MODE_NAMES[parsed.usageMode],
      batteryPercent: parsed.batteryPercent,
      ...this.summarizeLevel(parsed),
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
};

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
