'use strict';

/* CommonJS keeps this regression harness outside the TypeScript production build. */

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');

class MockDevice {}

const originalLoad = Module._load;
Module._load = function loadWithHomeyMock(request, parent, isMain) {
  if (request === 'homey') {
    return { Device: MockDevice };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const Senso4sDevice = require('../.homeybuild/drivers/senso4s/device.js');
Module._load = originalLoad;
const { SCAN_FILTER_UUID } = require('../.homeybuild/lib/senso4s.js');

const PERIPHERAL_UUID = 'aabbccddeeff';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createDevice() {
  const device = new Senso4sDevice();
  const timers = [];
  const intervals = [];
  const logs = [];
  const errors = [];
  const capabilityUpdates = [];

  device.homey = {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      timer.cleared = true;
    },
    setInterval(callback, delay) {
      const timer = { callback, delay, cleared: false };
      intervals.push(timer);
      return timer;
    },
    clearInterval(timer) {
      timer.cleared = true;
    },
  };
  device.log = (...args) => logs.push(args);
  device.error = (...args) => errors.push(args);
  device.setCapabilityValueIfChanged = async (capability, value) => {
    capabilityUpdates.push({ capability, value });
  };

  return {
    device,
    timers,
    intervals,
    logs,
    errors,
    capabilityUpdates,
    async fireTimer(delay) {
      let timer = null;
      for (let attempt = 0; attempt < 10 && !timer; attempt += 1) {
        timer = timers.find((candidate) => !candidate.cleared && candidate.delay === delay);
        if (!timer) {
          await flush();
        }
      }
      assert.ok(timer, `Expected an active ${delay} ms timer`);
      timer.cleared = true;
      timer.callback();
    },
  };
}

function createAdvertisementDevice() {
  const fixture = createDevice();
  const { device } = fixture;
  const store = { peripheralUuid: PERIPHERAL_UUID, address: 'AA:BB:CC:DD:EE:FF' };
  const advertisement = { uuid: PERIPHERAL_UUID, address: store.address, rssi: -50 };
  const subscriptions = [];
  const unsubscriptions = [];
  const handled = [];
  device.getStore = () => store;
  device.getData = () => ({ id: store.address });
  device.getSettings = () => ({});
  device.setStoreValue = async (key, value) => { store[key] = value; };
  device.ensureCapabilities = async () => undefined;
  device.removeDeprecatedCapabilities = async () => undefined;
  device.updateFromConnection = async () => undefined;
  device.handleAdvertisement = async (value, source) => { handled.push({ value, source }); };
  device.homey.hasFeature = (feature) => feature === 'ble-advertisements';
  device.homey.ble = {
    find: async () => advertisement,
    discover: async () => [advertisement],
    async subscribeToAdvertisements(uuid, callback) {
      assert.equal(this, device.homey.ble);
      assert.equal(typeof uuid, 'string');
      assert.match(uuid, /^[0-9a-f]{12}$/i);
      assert.equal(typeof callback, 'function');
      subscriptions.push({ uuid, callback });
      // SDK 1.7.0 resolves undefined, never an unsubscribe function.
    },
    async unsubscribeFromAdvertisements(uuid) {
      assert.equal(this, device.homey.ble);
      assert.equal(typeof uuid, 'string');
      unsubscriptions.push(uuid);
    },
  };
  return { ...fixture, store, advertisement, subscriptions, unsubscriptions, handled };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

test('coalesces concurrent active BLE reads into one operation', async () => {
  const { device } = createDevice();
  const activeRead = deferred();
  let performCalls = 0;

  device.performActiveRead = async () => {
    performCalls += 1;
    await activeRead.promise;
  };

  const first = device.updateFromConnection();
  const second = device.updateFromConnection();
  assert.equal(performCalls, 1);

  activeRead.resolve();
  await Promise.all([first, second]);

  assert.equal(performCalls, 1);
  assert.equal(device.activeReadOperation, null);
});

test('active-read deadline releases ownership even when disconnect never settles', async () => {
  const {
    device,
    capabilityUpdates,
    fireTimer,
  } = createDevice();
  let disconnectCalls = 0;

  device.performActiveRead = async (attemptId) => {
    device.activePeripheral = {
      attemptId,
      peripheral: {
        disconnect() {
          disconnectCalls += 1;
          return new Promise(() => undefined);
        },
      },
    };
    await new Promise(() => undefined);
  };

  const update = device.updateFromConnection();
  await fireTimer(45_000);
  await flush();
  await fireTimer(5_000);
  await update;

  assert.equal(disconnectCalls, 1);
  assert.equal(device.activePeripheral, null);
  assert.equal(device.activeReadOperation, null);
  assert.deepEqual(capabilityUpdates.at(-1), {
    capability: 'alarm_connectivity',
    value: true,
  });
});

test('disconnects a peripheral that arrives after its active-read deadline', async () => {
  const { device, fireTimer } = createDevice();
  const connection = deferred();
  let disconnectCalls = 0;

  device.findAdvertisement = async () => ({
    uuid: 'late-peripheral',
    address: 'AA:BB:CC:DD:EE:FF',
    rssi: -50,
    connect: () => connection.promise,
  });
  device.setUpdateMethod = async () => undefined;

  const update = device.updateFromConnection();
  await flush();
  await fireTimer(45_000);
  await update;

  connection.resolve({
    disconnect: async () => {
      disconnectCalls += 1;
    },
  });
  await flush();
  await flush();

  assert.equal(disconnectCalls, 1);
  assert.equal(device.activePeripheral, null);
});

test('level-notification cleanup cannot block the active read forever', async () => {
  const { device, fireTimer } = createDevice();
  let unsubscribeCalls = 0;
  const characteristic = {
    subscribeToNotifications: async () => undefined,
    unsubscribeFromNotifications() {
      unsubscribeCalls += 1;
      return new Promise(() => undefined);
    },
  };
  const peripheral = {
    read: async () => {
      throw new Error('direct read unavailable');
    },
    getService: async () => ({
      getCharacteristic: async () => characteristic,
    }),
  };

  const read = device.readLevelByte(peripheral);
  await flush();
  await fireTimer(5_000);
  await flush();
  await fireTimer(5_000);

  assert.equal(await read, null);
  assert.equal(unsubscribeCalls, 1);
});

test('shutdown cancels and awaits the active read while disconnecting once', async () => {
  const { device } = createDevice();
  let disconnectCalls = 0;

  device.performActiveRead = async (attemptId) => {
    device.activePeripheral = {
      attemptId,
      peripheral: {
        disconnect: async () => {
          disconnectCalls += 1;
        },
      },
    };
    await new Promise(() => undefined);
  };

  const update = device.updateFromConnection();
  await flush();
  await device.shutdownBleLifecycle('test shutdown');
  await update;

  assert.equal(disconnectCalls, 1);
  assert.equal(device.shuttingDown, true);
  assert.equal(device.activePeripheral, null);
  assert.equal(device.activeReadOperation, null);
});

test('initialization cannot restart timers after concurrent shutdown', async () => {
  const { device } = createDevice();
  const activeRead = deferred();
  let startTimerCalls = 0;

  device.getData = () => ({ id: 'senso4s' });
  device.getStore = () => ({});
  device.ensureCapabilities = async () => undefined;
  device.removeDeprecatedCapabilities = async () => undefined;
  device.loadSettings = () => undefined;
  device.startAdvertisementSubscription = async () => undefined;
  device.updateFromAdvertisement = async () => undefined;
  device.updateFromConnection = async () => activeRead.promise;
  device.startTimers = () => {
    startTimerCalls += 1;
  };

  const initialization = device.onInit();
  await flush();
  await device.shutdownBleLifecycle('test shutdown during initialization');
  activeRead.resolve();
  await initialization;

  assert.equal(startTimerCalls, 0);
  assert.equal(device.shuttingDown, true);
});

test('late advertisement subscription is boundedly removed after shutdown', async () => {
  const { device, fireTimer, subscriptions, unsubscriptions, handled, advertisement, logs } = createAdvertisementDevice();
  const subscription = deferred();
  const subscribe = device.homey.ble.subscribeToAdvertisements;
  device.homey.ble.subscribeToAdvertisements = async function delayedSubscribe(uuid, callback) {
    await subscribe.call(this, uuid, callback);
    await subscription.promise;
  };
  device.homey.ble.unsubscribeFromAdvertisements = async (uuid) => {
    unsubscriptions.push(uuid);
    await new Promise(() => undefined);
  };

  const start = device.startAdvertisementSubscription();
  await flush();
  assert.equal(subscriptions.length, 1);
  await device.shutdownBleLifecycle('test shutdown before subscription resolves');
  subscription.resolve();
  await subscriptions[0].callback(advertisement);
  await flush();
  await fireTimer(5_000);
  await start;

  assert.deepEqual(unsubscriptions, [PERIPHERAL_UUID]);
  assert.equal(device.advertisementSubscription, null);
  assert.equal(device.advertisementSubscriptionOperation, null);
  assert.equal(handled.length, 0);
  assert.ok(logs.some(([message]) => message.includes('Late BLE advertisement unsubscription did not finish')));
});

test('subscribes with the paired UUID string and treats an undefined result as success', async () => {
  const { device, subscriptions, advertisement, handled, store } = createAdvertisementDevice();
  device.homey.ble.find = async () => { throw new Error('Stored UUID needs no lookup'); };
  await device.startAdvertisementSubscription();

  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].uuid, store.peripheralUuid);
  assert.notEqual(subscriptions[0].uuid, device.getData().id);
  assert.notEqual(subscriptions[0].uuid, SCAN_FILTER_UUID);
  assert.equal(device.advertisementSubscription.uuid, PERIPHERAL_UUID);
  await subscriptions[0].callback(advertisement);
  await subscriptions[0].callback({ uuid: '001122334455', address: '00:11:22:33:44:55' });
  assert.deepEqual(handled, [{ value: advertisement, source: 'subscription' }]);
  device.startTimers();
  assert.equal(device.advertisementTimer.delay, 600_000);
});

test('explicitly unsubscribes once using the registered UUID even after the store changes', async () => {
  const { device, store, unsubscriptions } = createAdvertisementDevice();
  await device.startAdvertisementSubscription();
  store.peripheralUuid = '001122334455';
  await Promise.all([device.stopAdvertisementSubscription(), device.stopAdvertisementSubscription()]);

  assert.deepEqual(unsubscriptions, [PERIPHERAL_UUID]);
  assert.equal(device.advertisementSubscription, null);
});

for (const scenario of ['no feature API', 'unsupported', 'missing subscribe', 'missing unsubscribe', 'rejected', 'throws']) {
  test(`initialization keeps find/discover polling when subscription is ${scenario}`, async () => {
    const { device, subscriptions, unsubscriptions, advertisement, handled, logs } = createAdvertisementDevice();
    let findCalls = 0;
    let discoverCalls = 0;
    let activeReads = 0;
    if (scenario === 'no feature API') delete device.homey.hasFeature;
    if (scenario === 'unsupported') device.homey.hasFeature = () => false;
    if (scenario === 'missing subscribe') delete device.homey.ble.subscribeToAdvertisements;
    if (scenario === 'missing unsubscribe') delete device.homey.ble.unsubscribeFromAdvertisements;
    if (scenario === 'rejected') {
      device.homey.ble.subscribeToAdvertisements = async () => { throw new Error('registration rejected'); };
    }
    if (scenario === 'throws') {
      device.homey.ble.subscribeToAdvertisements = () => { throw new Error('registration threw'); };
    }
    device.homey.ble.find = async (uuid) => {
      assert.equal(uuid, PERIPHERAL_UUID);
      findCalls += 1;
      throw new Error('find unavailable');
    };
    device.homey.ble.discover = async (filter) => {
      assert.deepEqual(filter, [SCAN_FILTER_UUID]);
      discoverCalls += 1;
      return [advertisement];
    };
    device.updateFromConnection = async () => { activeReads += 1; };
    await device.onInit();

    assert.equal(findCalls, 1);
    assert.equal(discoverCalls, 1);
    assert.equal(activeReads, 1);
    assert.equal(subscriptions.length, 0);
    assert.deepEqual(unsubscriptions, []);
    assert.deepEqual(handled, [{ value: advertisement, source: 'poll' }]);
    assert.equal(device.advertisementSubscription, null);
    assert.equal(device.advertisementSubscriptionOperation, null);
    assert.equal(device.advertisementTimer.delay, 60_000);
    assert.ok(logs.some(([message]) => message.includes('find/discover fallback')));
  });
}

for (const storedUuid of [undefined, '', [SCAN_FILTER_UUID], SCAN_FILTER_UUID, 'AA:BB:CC:DD:EE:FF', 123]) {
  test(`resolves a peripheral via find/discover when the stored UUID is ${JSON.stringify(storedUuid)}`, async () => {
    const { device, store, subscriptions, advertisement } = createAdvertisementDevice();
    store.peripheralUuid = storedUuid;
    let discoverCalls = 0;
    device.homey.ble.find = async () => { throw new Error('find unavailable'); };
    device.homey.ble.discover = async (filter) => {
      assert.deepEqual(filter, [SCAN_FILTER_UUID]);
      discoverCalls += 1;
      return [advertisement];
    };
    await device.startAdvertisementSubscription();

    assert.equal(discoverCalls, 1);
    assert.equal(subscriptions[0].uuid, PERIPHERAL_UUID);
    assert.equal(store.peripheralUuid, PERIPHERAL_UUID);
    assert.equal(device.getData().id, 'AA:BB:CC:DD:EE:FF');
  });
}

for (const invalidUuid of [undefined, null, [], [SCAN_FILTER_UUID], SCAN_FILTER_UUID, '', 'aabbccddeefg', 'AA:BB:CC:DD:EE:FF']) {
  test(`does not register an invalid UUID returned by discovery: ${JSON.stringify(invalidUuid)}`, async () => {
    const { device, store, subscriptions, logs } = createAdvertisementDevice();
    delete store.peripheralUuid;
    device.findAdvertisement = async () => ({ uuid: invalidUuid });
    await device.startAdvertisementSubscription();
    device.startTimers();

    assert.equal(subscriptions.length, 0);
    assert.equal(device.advertisementSubscription, null);
    assert.equal(device.advertisementTimer.delay, 60_000);
    assert.ok(logs.some(([, error]) => error?.message?.includes('Invalid BLE peripheral UUID')));
  });
}

test('concurrent and repeated initialization creates one subscription and one pair of timers', async () => {
  const { device, subscriptions, intervals } = createAdvertisementDevice();
  const subscription = deferred();
  const subscribe = device.homey.ble.subscribeToAdvertisements;
  device.homey.ble.subscribeToAdvertisements = async function delayedSubscribe(uuid, callback) {
    await subscribe.call(this, uuid, callback);
    await subscription.promise;
  };
  const first = device.onInit();
  const second = device.onInit();
  for (let i = 0; i < 5; i += 1) await flush();
  assert.equal(subscriptions.length, 1);
  assert.equal(device.advertisementSubscription, null);
  assert.equal(intervals.length, 0);

  subscription.resolve();
  await Promise.all([first, second]);
  await device.onInit();
  assert.equal(subscriptions.length, 1);
  assert.equal(device.advertisementTimer.delay, 600_000);
  assert.equal(intervals.filter((timer) => !timer.cleared).length, 2);
});

test('polling switches to the subscribed interval only after registration completes', async () => {
  const { device } = createAdvertisementDevice();
  const subscription = deferred();
  device.homey.ble.subscribeToAdvertisements = async () => subscription.promise;
  const start = device.startAdvertisementSubscription();
  device.startTimers();
  const fallbackTimer = device.advertisementTimer;
  assert.equal(fallbackTimer.delay, 60_000);
  subscription.resolve();
  await start;

  assert.equal(fallbackTimer.cleared, true);
  assert.equal(device.advertisementTimer.delay, 600_000);
});

test('failed registration releases its pending operation so a later attempt can succeed', async () => {
  const { device, subscriptions } = createAdvertisementDevice();
  const subscribe = device.homey.ble.subscribeToAdvertisements;
  device.homey.ble.subscribeToAdvertisements = async () => { throw new Error('registration rejected'); };
  await device.onInit();
  assert.equal(device.advertisementTimer.delay, 60_000);
  device.homey.ble.subscribeToAdvertisements = subscribe;
  await device.startAdvertisementSubscription();

  assert.equal(subscriptions.length, 1);
  assert.equal(device.advertisementTimer.delay, 600_000);
});

test('shutdown during peripheral lookup prevents registration and timer recreation', async () => {
  const { device, store, subscriptions, intervals, advertisement } = createAdvertisementDevice();
  delete store.peripheralUuid;
  const lookup = deferred();
  device.findAdvertisement = async () => lookup.promise;
  const init = device.onInit();
  for (let i = 0; i < 5; i += 1) await flush();
  await device.onUninit();
  lookup.resolve(advertisement);
  await init;

  assert.equal(subscriptions.length, 0);
  assert.equal(intervals.length, 0);
  assert.equal(device.advertisementSubscriptionOperation, null);
});

for (const cleanupFailure of ['rejected', 'throws', 'never settles']) {
  test(`shutdown clears subscription ownership and remains bounded when unsubscribe ${cleanupFailure}`, async () => {
    const { device, fireTimer, logs } = createAdvertisementDevice();
    const calls = [];
    device.homey.ble.unsubscribeFromAdvertisements = (uuid) => {
      calls.push(uuid);
      if (cleanupFailure === 'throws') throw new Error('unsubscribe threw');
      if (cleanupFailure === 'rejected') return Promise.reject(new Error('unsubscribe rejected'));
      return new Promise(() => undefined);
    };
    await device.onInit();
    const shutdown = device.onUninit();
    assert.equal(device.advertisementSubscription, null);
    if (cleanupFailure === 'never settles') await fireTimer(5_000);
    await shutdown;
    await device.onDeleted();

    assert.deepEqual(calls, [PERIPHERAL_UUID]);
    assert.equal(device.advertisementTimer, null);
    assert.equal(device.connectionTimer, null);
    assert.ok(logs.some(([message]) => message.startsWith('BLE advertisement unsubscription ')));
  });
}
