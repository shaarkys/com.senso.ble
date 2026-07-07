import Homey from 'homey';
import {
  ANOMALY_NAMES,
  DEFAULT_CONNECTION_INTERVAL_MINUTES,
  DEFAULT_GAS_CAPACITY_KG,
  DEFAULT_LOW_LEVEL_THRESHOLD,
  ERROR_DESCRIPTIONS,
  isSenso4sAdvertisement,
  parseAdvertisement,
  USAGE_MODE_NAMES,
} from '../../lib/senso4s';

module.exports = class Senso4sDriver extends Homey.Driver {

  async onInit() {
    this.log('Senso4s driver has been initialized');
  }

  async onPairListDevices() {
    this.log('Scanning for Senso4s BLE devices');
    const advertisements = await this.homey.ble.discover([]);
    this.log(`BLE scan returned ${advertisements.length} advertisement(s)`);

    const devices = new Map<string, {
      name: string;
      data: { id: string };
      settings: {
        connection_interval_minutes: number;
        gas_capacity_kg: number;
        low_level_threshold: number;
      };
      store: {
        peripheralUuid: string;
        address: string;
        manufacturerId: number;
        macAddress: string;
        isPlusModel: boolean;
        usageMode: string;
      };
      rssi: number;
    }>();

    for (const advertisement of advertisements.filter(isSenso4sAdvertisement)) {
        const parsed = parseAdvertisement(advertisement);
        if (!parsed) {
          this.log('Skipping Senso4s advertisement without manufacturer data during pairing', JSON.stringify({
            uuid: advertisement.uuid,
            address: advertisement.address,
            localName: advertisement.localName,
            rssi: advertisement.rssi,
            serviceUuids: advertisement.serviceUuids,
          }));
          continue;
        }

        const address = (advertisement.address || parsed?.macAddress || advertisement.uuid).toUpperCase();
        const name = parsed
          ? `Senso4s ${parsed.isPlusModel ? 'Plus' : 'Basic'} (${address})`
          : `Senso4s (${address})`;

        this.log(
          'Senso4s advertisement',
          JSON.stringify({
            uuid: advertisement.uuid,
            address: advertisement.address,
            localName: advertisement.localName,
            rssi: advertisement.rssi,
            serviceUuids: advertisement.serviceUuids,
            manufacturerData: advertisement.manufacturerData?.toString('hex') || null,
            decoded: parsed ? summarizeParsedAdvertisement(parsed) : null,
          }),
        );

        const device = {
          name,
          data: {
            id: address,
          },
          settings: {
            connection_interval_minutes: DEFAULT_CONNECTION_INTERVAL_MINUTES,
            gas_capacity_kg: DEFAULT_GAS_CAPACITY_KG,
            low_level_threshold: DEFAULT_LOW_LEVEL_THRESHOLD,
          },
          store: {
            peripheralUuid: advertisement.uuid,
            address,
            manufacturerId: parsed.manufacturerId,
            macAddress: parsed.macAddress,
            isPlusModel: parsed.isPlusModel,
            usageMode: USAGE_MODE_NAMES[parsed.usageMode],
          },
          rssi: advertisement.rssi,
        };

        const existing = devices.get(address);
        if (!existing || advertisement.rssi > existing.rssi) {
          devices.set(address, device);
        }
    }

    return Array.from(devices.values()).map(({ rssi, ...device }) => device);
  }

};

function summarizeParsedAdvertisement(parsed: NonNullable<ReturnType<typeof parseAdvertisement>>) {
  return {
    manufacturerId: parsed.manufacturerId ? `0x${parsed.manufacturerId.toString(16).padStart(4, '0')}` : null,
    macAddress: parsed.macAddress,
    model: parsed.isPlusModel ? 'Plus' : 'Basic',
    usageMode: USAGE_MODE_NAMES[parsed.usageMode],
    gasLevelPercent: parsed.gasLevelPercent,
    batteryPercent: parsed.batteryPercent,
    needsCalibration: parsed.needsCalibration,
    hasError: parsed.hasError,
    errorCode: parsed.errorCode,
    errorDescription: parsed.errorCode ? ERROR_DESCRIPTIONS[parsed.errorCode] : null,
    anomalies: parsed.anomalies.map((anomaly) => ANOMALY_NAMES[anomaly]),
  };
}
